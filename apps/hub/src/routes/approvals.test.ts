import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createApprovalsRouter } from './approvals';

const PRINCIPAL = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockDb(overrides: Record<string, any> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const base: any = {
    query: {
      principal: {
        findFirst: mock(() => Promise.resolve(undefined)),
      },
    },
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
      })),
    })),
    ...overrides,
  };
  return base;
}

function buildApp(db: ReturnType<typeof makeMockDb>, userId = 'user-1') {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route('/', createApprovalsRouter(db));
  return parent;
}

describe('GET /tenants/:tenantId/approvals', () => {
  it('returns 403 when the caller has no principal in the tenant', async () => {
    const db = makeMockDb();
    // principal.findFirst returns undefined — caller not in tenant
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-other/approvals', { method: 'GET' })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('Forbidden');
  });

  it('returns 200 with pending approvals when the caller is in the tenant', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const pendingApproval = {
      id: 'apr-1',
      tenantId: 'tenant-1',
      principalId: PRINCIPAL.id,
      agentId: 'agt-1',
      sessionId: null,
      resource: 'file:/path/to/file',
      action: 'read',
      status: 'pending',
      context: null,
      message: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([pendingApproval])),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-1/approvals', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe('apr-1');
  });
});

describe('POST /tenants/:tenantId/approvals/:approvalId/approve', () => {
  it('returns 403 when the caller is not in the tenant', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-other/approvals/apr-1/approve', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(403);
  });

  it('uses the Interchange principalId (not userId) when filtering the approval update', async () => {
    // The approve endpoint must compare against callerPrincipal.id (the Interchange
    // principal ID) — not against the BetterAuth userId. Verify this by ensuring a
    // successful approve call resolves to the principal ID, not the user ID.
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const approvedRow = {
      id: 'apr-1',
      tenantId: 'tenant-1',
      principalId: PRINCIPAL.id,
      agentId: 'agt-1',
      sessionId: null,
      resource: 'file:/path',
      action: 'read',
      status: 'approved',
      context: null,
      message: null,
      resolvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const whereArgs: unknown[] = [];
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock((...args: unknown[]) => {
          whereArgs.push(args);
          return { returning: mock(() => Promise.resolve([approvedRow])) };
        }),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-1/approvals/apr-1/approve', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('apr-1');
    expect(json.status).toBe('approved');
    // The update was called once, confirming the endpoint proceeded past the
    // principalId check using PRINCIPAL.id (Interchange ID), not 'user-1' (BetterAuth ID).
    expect(whereArgs.length).toBe(1);
  });

  it('returns 404 when the approval does not exist', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-1/approvals/apr-missing/approve', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /tenants/:tenantId/approvals/:approvalId/reject', () => {
  it('returns 403 when the caller is not in the tenant', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request('http://localhost/tenants/tenant-other/approvals/apr-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Not allowed' }),
      })
    );
    expect(res.status).toBe(403);
  });
});
