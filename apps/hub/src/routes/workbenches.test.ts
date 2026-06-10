import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';

mock.module('../config', () => ({
  getConfig: () => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  }),
  loadConfig: () => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  }),
}));

import { createWorkbenchesRouter } from './workbenches';

describe('Workbenches router', () => {
  const GLOBAL_TENANT = { id: 'tn-global', slug: 'global-org', name: 'Global Org' };

  function makeTenant(overrides?: Partial<{ id: string; slug: string; name: string }>) {
    return {
      id: 'tn-1',
      slug: 'acme-corp',
      name: 'Acme Corp',
      domain: 'acme-corp.localhost',
      ...overrides,
    };
  }

  function makePrincipal(overrides?: Partial<{ id: string }>) {
    return { id: 'pr-1', ...overrides };
  }

  // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
  type MockDb = any;

  /**
   * Wraps the workbenches router in a Hono app that sets the `userId` context
   * variable before each request — mirrors what auth middleware does in production.
   */
  function wrapWithAuth(router: Hono<{ Variables: { userId: string } }>, userId = 'user-1'): Hono {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, userId);
      await next();
    });
    app.route('/', router);
    return app;
  }

  function createMockDb(opts?: {
    existingTenant?: { id: string; slug: string; name: string } | null;
    existingPrincipal?: { id: string } | null;
  }): MockDb {
    const existingTenant = opts?.existingTenant ?? null;
    const existingPrincipal = opts?.existingPrincipal ?? null;

    // When the workbench already exists, every tenant lookup (the slug check and
    // the route's re-fetch by id) returns it. On the create path the first
    // lookup (workbench slug) misses and the next (the parent global tenant
    // lookup provisionWorkbenchTenant performs) returns the global tenant.
    let tenantCall = 0;
    const tenantFindFirst = mock(() => {
      tenantCall += 1;
      if (existingTenant) return Promise.resolve(existingTenant);
      return Promise.resolve(tenantCall >= 2 ? GLOBAL_TENANT : undefined);
    });

    const db: MockDb = {
      transaction: mock(async <T>(fn: (tx: MockDb) => Promise<T>): Promise<T> => {
        return fn(db as MockDb);
      }),
      query: {
        tenant: {
          findFirst: tenantFindFirst,
        },
        principal: {
          findFirst: mock(() => Promise.resolve(existingPrincipal ?? undefined)),
        },
        role: {
          findFirst: mock(() => Promise.resolve({ id: 'role-owner' })),
        },
        grant: {
          findFirst: mock(() => Promise.resolve(undefined)),
        },
      },
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([makeTenant()])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
    };
    return db;
  }

  it('POST /workbenches creates a tenant and principal', async () => {
    const db = createMockDb();
    const app = wrapWithAuth(createWorkbenchesRouter(db as any));
    const res = await app.fetch(
      new Request('http://localhost:4000/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp' }),
      })
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { name: string; slug: string };
    expect(json.name).toBeDefined();
    expect(json.slug).toBeDefined();
  });

  it('POST /workbenches returns 400 for missing name', async () => {
    const db = createMockDb();
    const app = wrapWithAuth(createWorkbenchesRouter(db as any));
    const res = await app.fetch(
      new Request('http://localhost:4000/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  it('POST /workbenches returns 400 for empty name', async () => {
    const db = createMockDb();
    const app = wrapWithAuth(createWorkbenchesRouter(db as any));
    const res = await app.fetch(
      new Request('http://localhost:4000/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('POST /workbenches is idempotent — returns existing workbench if user is already a principal', async () => {
    const db = createMockDb({
      existingTenant: makeTenant(),
      existingPrincipal: makePrincipal(),
    });
    const app = wrapWithAuth(createWorkbenchesRouter(db as any));
    const res = await app.fetch(
      new Request('http://localhost:4000/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp' }),
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { slug: string };
    expect(json.slug).toBe('acme-corp');
  });

  it('POST /workbenches returns 409 when slug exists but user is not a principal', async () => {
    const db = createMockDb({
      existingTenant: makeTenant(),
      existingPrincipal: null,
    });
    const app = wrapWithAuth(createWorkbenchesRouter(db as any));
    const res = await app.fetch(
      new Request('http://localhost:4000/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp' }),
      })
    );
    expect(res.status).toBe(409);
  });
});
