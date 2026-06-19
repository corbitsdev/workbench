import { Hono } from 'hono';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { and, eq } from 'drizzle-orm';
import { HUB_BACKED_TOOLS } from '../lib/hub-backed-tools';
import { buildToolDefinitions, getToolNamesFromCapabilities } from '../lib/tool-registry';
import type { SessionService, EventCollectorRegistry, SidecarRouter } from '@intx/hub-sessions';

const log = getLogger(['api', 'hub-tools']);

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

  router.post('/hub-tools/run', async (c) => {
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
      return c.json({ error: `Tool ${toolName} uses unsupported handler kind: ${tool.kind}` }, 500);
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
  });

  return router;
}
