import { Hono } from 'hono';
import { type } from 'arktype';
import { describeRoute, resolver } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { schema as intxSchema, resolveCredentialRequirement } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { ToolCredentialsRequest, type ToolCredential } from '@workbench/tool-credentials';
import { providersForToolPackages } from '@workbench/agents';
import { ToolPackagePin } from '@intx/types/tool-packages';
import { requestBodySchema } from '../lib/openapi';

const log = getLogger(['api', 'tool-credentials']);

const ToolPackagePins = ToolPackagePin.array();

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover this operation; these schemas document (they do not replace) the
// handler's existing manual validation. The per-provider credential carries a
// secret apiKey — never logged or echoed; documented as opaque here.
const ToolCredentialsResponse = type({
  credentials: type.Record('string', { apiKey: 'unknown', baseURL: 'string' }),
});
const ErrorResponse = type({ error: 'string' });

/**
 * The credential providers an agent may request: the providers of the tool
 * packages it has pinned. Derived from the agent's persisted `toolPackages`
 * (the native pins), so a workflow step — provisioned as a real agent row with
 * its step pins — is gated identically to any other agent. A holder of the
 * sidecar token cannot resolve arbitrary tenant credentials by name.
 */
function allowedProvidersForAgent(toolPackages: unknown): Set<string> {
  const pins = ToolPackagePins(toolPackages);
  if (pins instanceof type.errors) return new Set();
  return new Set(providersForToolPackages(pins));
}

/**
 * Credential rail for in-sidecar native tool packages. Resolves the
 * tenant-owned credential for each requested provider and returns the
 * apiKey + baseURL, scoped to the providers the agent is actually allowed
 * to use (a holder of the sidecar token cannot resolve arbitrary tenant
 * credentials by name). Delivered separately from inference sources.
 */
export function createToolCredentialsRouter(
  db: DB['db'],
  sidecarToken: string,
  resolveCredential: typeof resolveCredentialRequirement = resolveCredentialRequirement
): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${sidecarToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  router.post(
    '/tools/credentials',
    describeRoute({
      tags: ['Tool Credentials'],
      summary: 'Resolve tool credentials for an agent',
      description:
        'Sidecar-gated (sidecar token). Resolves the tenant-owned credential for each requested provider and returns its apiKey + baseURL, scoped to the providers the named agent is allowed to use (derived from its pinned tool packages). The response apiKey fields are secrets — callers must not log or persist them. Body fields: `tenantId`, `agentId`, and `providerNames` (the providers to resolve).',
      requestBody: {
        required: true,
        description:
          'Body fields: `tenantId`, `agentId`, and `providerNames` (the tool providers to resolve).',
        content: {
          'application/json': { schema: requestBodySchema(ToolCredentialsRequest) },
        },
      },
      responses: {
        200: {
          description: 'Resolved credentials (apiKey values are secrets)',
          content: {
            'application/json': { schema: resolver(ToolCredentialsResponse) },
          },
        },
        400: {
          description: 'Invalid JSON or request body',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: 'Missing or invalid sidecar token',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: 'Agent may not request one or more of the named providers',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Unknown agent',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        422: {
          description: 'No credential configured for a requested provider',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: 'Credential resolution failed',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      const parsed = ToolCredentialsRequest(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `Invalid request: ${parsed.summary}` }, 400);
      }

      const agentRow = await db.query.agent.findFirst({
        where: eq(intxSchema.agent.id, parsed.agentId),
      });
      if (!agentRow) {
        return c.json({ error: `Agent not found: ${parsed.agentId}` }, 404);
      }
      const allowed = allowedProvidersForAgent(agentRow.toolPackages);
      const forbidden = parsed.providerNames.filter((p) => !allowed.has(p));
      if (forbidden.length > 0) {
        return c.json(
          {
            error: `Agent ${parsed.agentId} may not request providers: ${forbidden.join(', ')}`,
          },
          403
        );
      }

      const credentials: Record<string, ToolCredential> = {};
      for (const providerName of parsed.providerNames) {
        let resolved: Awaited<ReturnType<typeof resolveCredentialRequirement>>;
        try {
          resolved = await resolveCredential(
            db,
            parsed.tenantId,
            { providerName, source: 'tenant' },
            null,
            null
          );
        } catch (err) {
          log.error('Tool credential resolution failed', {
            tenantId: parsed.tenantId,
            providerName,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: `Credential resolution failed for ${providerName}` }, 500);
        }
        if (!resolved) {
          return c.json({ error: `No credential configured for provider: ${providerName}` }, 422);
        }
        const providerRow = await db.query.provider.findFirst({
          where: (p, { eq: eqp }) => eqp(p.id, resolved.providerId),
        });
        const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };
        credentials[providerName] = {
          apiKey: resolved.secret,
          baseURL: metadata.baseURL ?? '',
        };
      }

      return c.json({ credentials });
    }
  );

  return router;
}
