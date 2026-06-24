import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';

let forbidden = false;
let context: { tenantId: string } | null = { tenantId: 'tenant-1' };
mock.module('../lib/user-context', () => ({
  getRequestedUserContext: async () => ({ context, forbidden }),
}));

const listAvailableToolSummaries = mock(async (_db: unknown, _tenantId: string) => [
  { name: 'attio_query_records', providerName: 'attio', description: 'Find records.' },
]);
const getAvailableToolDetail = mock(async (_db: unknown, _tenantId: string, name: string) =>
  name === 'attio_query_records'
    ? { name, providerName: 'attio', description: 'Find records.', inputSchema: { properties: {} } }
    : null
);
mock.module('../lib/tenant-tools', () => ({ listAvailableToolSummaries, getAvailableToolDetail }));

const { createToolsRouter } = await import('./tools');

const db = {} as unknown as Parameters<typeof createToolsRouter>[0];

// createToolsRouter reads c.get('userId') (set by the v1 auth middleware in
// production); seed it via a parent-app pre-middleware so it runs before the
// route handlers.
async function call(path: string) {
  const app = new Hono<{ Variables: { userId: string; userName: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/', createToolsRouter(db));
  return app.request(path);
}

describe('createToolsRouter', () => {
  it('lists tenant-available tools', async () => {
    context = { tenantId: 'tenant-1' };
    forbidden = false;
    const res = await call('/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools[0]?.name).toBe('attio_query_records');
  });

  it('returns a tool detail with input schema', async () => {
    const res = await call('/tools/attio_query_records');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tool: { name: string; inputSchema: unknown } };
    expect(body.tool.name).toBe('attio_query_records');
    expect('inputSchema' in body.tool).toBe(true);
  });

  it('404s when the tenant cannot run the tool', async () => {
    const res = await call('/tools/linear_list_issues');
    expect(res.status).toBe(404);
  });

  it('403s when the requested tenant is not accessible', async () => {
    forbidden = true;
    const res = await call('/tools');
    expect(res.status).toBe(403);
    forbidden = false;
  });
});
