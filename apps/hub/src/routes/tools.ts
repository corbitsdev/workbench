import { Hono } from 'hono';
import { type } from 'arktype';
import { describeRoute, resolver } from 'hono-openapi';
import type { HubDb } from '../db';
import { getRequestedUserContext } from '../lib/user-context';
import { getAvailableToolDetail, listAvailableToolSummaries } from '../lib/tenant-tools';

/**
 * Tenant-scoped catalog of the tools a tenant can actually run, for the web
 * "Tools" gallery. Credential tools appear only when the tenant has a resolvable
 * credential for the provider; context/hub-backed tools are always present. The
 * detail view adds the tool's input schema so the page can render its params.
 */

const ToolSummary = type({ name: 'string', providerName: 'string', description: 'string' });
const ToolList = type({ tools: ToolSummary.array() });
const ToolDetailResponse = type({ tool: ToolSummary.merge({ inputSchema: 'unknown' }) });
const ErrorResponse = type({ error: 'string' });

const TENANT_PARAM = {
  name: 'tenantId',
  in: 'query' as const,
  required: false,
  description: 'Target workbench tenant id. Omit for the active workbench.',
  schema: { type: 'string' as const },
};

export function createToolsRouter(
  db: HubDb
): Hono<{ Variables: { userId: string; userName: string } }> {
  const router = new Hono<{ Variables: { userId: string; userName: string } }>();

  router.get(
    '/tools',
    describeRoute({
      tags: ['Tools'],
      summary: 'List tools available to the workbench',
      description:
        'Lists the tools the tenant can actually run: credential tools whose provider has a resolvable credential, plus the always-available hub-backed tools.',
      parameters: [TENANT_PARAM],
      responses: {
        200: {
          description: 'Tools available to the workbench',
          content: { 'application/json': { schema: resolver(ToolList) } },
        },
        403: {
          description: 'Caller is not a member of the requested tenant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const { context, forbidden } = await getRequestedUserContext(
        db,
        c.get('userId'),
        c.req.query('tenantId')
      );
      if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);
      const tools = await listAvailableToolSummaries(db, context.tenantId);
      return c.json({ tools });
    }
  );

  router.get(
    '/tools/:name',
    describeRoute({
      tags: ['Tools'],
      summary: 'Get one tool the workbench can run',
      description:
        'Returns a single tool with its input schema. 404 if the tool does not exist or the tenant cannot run it.',
      parameters: [
        { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        TENANT_PARAM,
      ],
      responses: {
        200: {
          description: 'The tool and its input schema',
          content: { 'application/json': { schema: resolver(ToolDetailResponse) } },
        },
        403: {
          description: 'Caller is not a member of the requested tenant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: 'Tool not found or not available to this tenant',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const { context, forbidden } = await getRequestedUserContext(
        db,
        c.get('userId'),
        c.req.query('tenantId')
      );
      if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
      if (!context) return c.json({ error: 'User context not found' }, 403);
      const tool = await getAvailableToolDetail(db, context.tenantId, c.req.param('name'));
      if (tool === null) return c.json({ error: 'Tool not found' }, 404);
      return c.json({ tool });
    }
  );

  return router;
}
