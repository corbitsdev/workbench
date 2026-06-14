import { Hono } from 'hono';
import { resolveCredentialRequirement } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import type { AgentTool } from '@intx/agent';
import { isCredentialToolEntry, KNOWN_TOOLS, buildToolDefinitions } from '../lib/tool-registry';
import type { SessionService, EventCollectorRegistry, SidecarRouter } from '@intx/hub-sessions';

const log = getLogger(['api', 'tools']);

export function createInternalToolsRouter(
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

  router.post('/tools/run', async (c) => {
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

    const entry = KNOWN_TOOLS[toolName];
    if (!entry) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }

    if (!isCredentialToolEntry(entry)) {
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
        log.error('Tool execution failed', { tenantId, toolName, error: message });
        return c.json({ result: message, isError: true });
      }
    }

    let resolved: Awaited<ReturnType<typeof resolveCredentialRequirement>>;
    try {
      resolved = await resolveCredentialRequirement(
        db,
        tenantId,
        { providerName: entry.providerName, source: 'tenant' },
        null,
        null
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Credential resolution failed', { tenantId, toolName, error: message });
      return c.json({ result: `Credential resolution failed: ${message}`, isError: true });
    }

    if (!resolved) {
      log.error('No credential configured for tool execution', {
        tenantId,
        toolName,
        providerName: entry.providerName,
      });
      return c.json({ error: `No credential configured for provider: ${entry.providerName}` }, 422);
    }

    const apiKey = resolved.secret;
    let baseURL: string;
    try {
      const providerRow = await db.query.provider.findFirst({
        where: (p, { eq }) => eq(p.id, resolved.providerId),
      });
      const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };
      baseURL = metadata.baseURL ?? '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Provider lookup failed', {
        tenantId,
        toolName,
        error: message,
      });
      return c.json({ result: `Credential setup failed: ${message}`, isError: true });
    }

    let tool: AgentTool | undefined;
    try {
      const tools = entry.createTools({ apiKey, baseURL });
      tool = tools.find((t) => t.definition.name === toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Tool factory failed', { tenantId, toolName, error: message });
      return c.json({ result: `Tool initialization failed: ${message}`, isError: true });
    }

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
      log.error('Tool execution failed', { tenantId, toolName, error: message });
      return c.json({ result: message, isError: true });
    }
  });

  return router;
}
