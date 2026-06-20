import { type } from 'arktype';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { and, eq } from 'drizzle-orm';
import { HUB_BACKED_TOOLS } from '../lib/hub-backed-tools';
import { buildToolDefinitions, getToolNamesFromCapabilities } from '../lib/tool-registry';
import type { SessionService, EventCollectorRegistry, SidecarRouter } from '@intx/hub-sessions';
import { requestBodySchema } from '../lib/openapi';

const log = getLogger(['api', 'hub-tools']);

// Request/response shapes for the OpenAPI spec. The hub admin CLI consumes
// /openapi.json to discover this operation; these schemas document (they do
// not replace) the handler's existing manual validation. Tool args and the
// tool result are opaque per-tool payloads, hence `unknown`.
const RunToolBody = type({
  tenantId: 'string',
  agentId: 'string',
  principalId: 'string',
  sessionId: 'string',
  toolName: 'string',
  args: 'unknown',
});
const RunToolResponse = type({
  result: 'unknown',
  isError: 'boolean',
});
const ErrorResponse = type({ error: 'string' });

// Scoped execution endpoint for hub-backed native tool packages. The
// sidecar's `defineHubBackedToolPackage` factory forwards each call here
// with the agent's identity and the shared sidecar token. Unlike the
// legacy `/tools/run` proxy this endpoint serves only HUB_BACKED_TOOLS and
// authorizes every call against the agent definition's declared
// capabilities — a tool the agent was not granted is rejected (403).
export function createHubToolsRouter(
  db: DB['db'],
  sidecarToken: string,
  hubServices?: {
    sessionService: SessionService;
    eventCollectors: EventCollectorRegistry;
    sidecarRouter: SidecarRouter;
    buildToolDefinitions: typeof buildToolDefinitions;
  }
): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${sidecarToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  router.post(
    '/hub-tools/run',
    describeRoute({
      tags: ['Tools'],
      summary: 'Run a hub-backed tool',
      description:
        "Sidecar-gated (sidecar token). Executes a single HUB_BACKED_TOOLS tool on behalf of an agent instance. The call is authorized against the identity triple (agent belongs to the claimed tenant, principal is an instance of that agent) and the tool must be in the agent definition's declared capabilities. A tool that throws is reported as `{ isError: true }` with HTTP 200.",
      requestBody: {
        content: { 'application/json': { schema: requestBodySchema(RunToolBody) } },
      },
      responses: {
        200: {
          description: 'Tool executed (check `isError` for tool-level failure)',
          content: { 'application/json': { schema: resolver(RunToolResponse) } },
        },
        400: {
          description: 'Invalid JSON or missing required fields',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: 'Missing or invalid sidecar token',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: 'Unknown agent, identity-triple mismatch, or tool not enabled for the agent',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Unknown hub tool',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: 'Tool missing from provider package or unsupported handler kind',
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

      if (
        typeof body !== 'object' ||
        body === null ||
        typeof (body as Record<string, unknown>)['tenantId'] !== 'string' ||
        typeof (body as Record<string, unknown>)['toolName'] !== 'string' ||
        typeof (body as Record<string, unknown>)['agentId'] !== 'string' ||
        typeof (body as Record<string, unknown>)['principalId'] !== 'string' ||
        typeof (body as Record<string, unknown>)['sessionId'] !== 'string' ||
        typeof (body as Record<string, unknown>)['args'] !== 'object'
      ) {
        return c.json(
          {
            error:
              'Missing required fields: tenantId, agentId, principalId, sessionId, toolName, args',
          },
          400
        );
      }

      const { tenantId, agentId, principalId, sessionId, toolName, args } = body as {
        tenantId: string;
        agentId: string;
        principalId: string;
        sessionId: string;
        toolName: string;
        args: Record<string, unknown>;
      };

      const entry = HUB_BACKED_TOOLS[toolName];
      if (!entry) {
        return c.json({ error: `Unknown hub tool: ${toolName}` }, 404);
      }

      // Authorize per-agent: the requested tool must be in the agent
      // definition's declared capabilities. In the shared org tenant an
      // unauthorized tool call would otherwise reach hub-owned data.
      const agentRow = await db.query.agent.findFirst({
        where: eq(intxSchema.agent.id, agentId),
      });
      if (!agentRow) {
        return c.json({ error: `Unknown agent: ${agentId}` }, 403);
      }
      // The endpoint owns the identity-triple consistency check rather than
      // relying on each tool to re-derive it: the agent must belong to the
      // claimed tenant, and the principal must be the principal of a real
      // instance of THIS agent in THIS tenant. This bounds a sidecar-token
      // holder to the instances it actually runs (no forged cross-agent or
      // cross-tenant identity).
      if (agentRow.tenantId !== tenantId) {
        return c.json({ error: 'Agent does not belong to the claimed tenant' }, 403);
      }
      const instance = await db.query.agentInstance.findFirst({
        where: and(
          eq(intxSchema.agentInstance.principalId, principalId),
          eq(intxSchema.agentInstance.agentId, agentId),
          eq(intxSchema.agentInstance.tenantId, tenantId)
        ),
      });
      if (!instance) {
        return c.json({ error: 'principalId is not an instance of this agent' }, 403);
      }
      const allowed = getToolNamesFromCapabilities(agentRow.capabilities ?? null);
      if (!allowed.includes(toolName)) {
        return c.json({ error: `Tool ${toolName} is not enabled for this agent` }, 403);
      }

      const tool = entry
        .createTools({
          db,
          tenantId,
          agentId,
          principalId,
          sessionId,
          ...hubServices,
        })
        .find((candidate) => candidate.definition.name === toolName);
      if (!tool) {
        return c.json({ error: `Tool ${toolName} not found in provider package` }, 500);
      }
      if (tool.kind !== 'string') {
        return c.json(
          { error: `Tool ${toolName} uses unsupported handler kind: ${tool.kind}` },
          500
        );
      }
      try {
        const controller = new AbortController();
        c.req.raw.signal.addEventListener('abort', () => controller.abort());
        const result = await tool.handler(args, controller.signal);
        return c.json({ result, isError: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Hub tool execution failed', { tenantId, toolName, error: message });
        return c.json({ result: message, isError: true });
      }
    }
  );

  return router;
}
