import { Hono } from 'hono';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { schema as intxSchema, resolveCredentialRequirement } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { ToolCredentialsRequest, type ToolCredential } from '@workbench/tool-credentials';
import {
  KNOWN_TOOLS,
  getToolNamesFromCapabilities,
  isCredentialToolEntry,
} from '../lib/tool-registry';

const log = getLogger(['api', 'tool-credentials']);

/**
 * The credential providers an agent may request: the providers of the
 * credentialed tools in its capabilities. Sourced from KNOWN_TOOLS' tool→
 * provider mapping today; once KNOWN_TOOLS is retired (workflow runtime
 * migration) this derives from the agent's pinned packages instead.
 */
function allowedProvidersForAgent(capabilities: unknown): Set<string> {
  const allowed = new Set<string>();
  for (const toolName of getToolNamesFromCapabilities(capabilities)) {
    const entry = KNOWN_TOOLS[toolName];
    if (entry !== undefined && isCredentialToolEntry(entry)) {
      allowed.add(entry.providerName);
    }
  }
  return allowed;
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

  router.post('/tools/credentials', async (c) => {
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
    const allowed = allowedProvidersForAgent(agentRow.capabilities);
    const forbidden = parsed.providerNames.filter((p) => !allowed.has(p));
    if (forbidden.length > 0) {
      return c.json(
        { error: `Agent ${parsed.agentId} may not request providers: ${forbidden.join(', ')}` },
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
      credentials[providerName] = { apiKey: resolved.secret, baseURL: metadata.baseURL ?? '' };
    }

    return c.json({ credentials });
  });

  return router;
}
