import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createAgentProvisioningRouter } from './agents';

// Build a request with the userId header that the test harness injects via middleware.
function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {}
): Request {
  const { method = 'GET', body, userId = 'user-1' } = opts;
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-user-id': userId,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Wrap the router in a parent app that sets the userId context variable,
// mirroring how the real hub mounts routers behind auth middleware.
function buildApp(db: ReturnType<typeof makeMockDb>, userId = 'user-1') {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route('/', createAgentProvisioningRouter(db as never));
  return parent;
}

// Build a select chain mock that resolves with `rows`.
// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeSelectChain(rows: any[] = []) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const chain: any = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => Promise.resolve(rows)),
  };
  return chain;
}

function makeMockDb(overrides: Record<string, unknown> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  let base: any;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
  base = {
    transaction: txMock,
    query: {
      principal: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      tenant: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      agent: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      agentInstance: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      provider: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      credential: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
    },
    // By default, no admin/owner roles
    select: mock(() => makeSelectChain([])),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
    ...overrides,
  };
  return base;
}

describe('GET /agents', () => {
  it('returns 400 when tenantId is missing', async () => {
    const db = makeMockDb();
    const app = buildApp(db);
    const res = await app.fetch(makeRequest('http://localhost/agents'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('tenantId');
  });

  it('returns 403 when the caller has no principal in the queried tenant', async () => {
    const db = makeMockDb();
    // principal.findFirst returns undefined (no principal for this tenant)
    const app = buildApp(db, 'user-1');
    const res = await app.fetch(makeRequest('http://localhost/agents?tenantId=tenant-other'));
    expect(res.status).toBe(403);
  });

  it('returns agent list when the caller has a principal in the tenant', async () => {
    const existingPrincipal = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };
    const existingInstance = {
      id: 'ins-1',
      agentId: 'agt-1',
      tenantId: 'tenant-1',
      address: 'ins-1@tenant-1.localhost',
      status: 'deployed',
      principalId: 'prn-agent-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const existingAgent = { id: 'agt-1', name: 'Oat', tenantId: 'tenant-1' };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: {
          findFirst: mock(() => Promise.resolve(existingAgent)),
          findMany: mock(() => Promise.resolve([existingAgent])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([existingInstance])),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: mock(() => ({
        values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    };

    const app = buildApp(base);
    const res = await app.fetch(makeRequest('http://localhost/agents?tenantId=tenant-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].agentName).toBe('Oat');
  });
});

describe('POST /agents', () => {
  it('returns 403 when the caller has no principal in the tenantId from the body', async () => {
    const db = makeMockDb();
    const app = buildApp(db, 'user-1');
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-nobody',
          credentialIds: ['crd-1'],
        },
      })
    );
    expect(res.status).toBe(403);
  });

  it('POST oat returns 201 and is idempotent', async () => {
    const existingPrincipal = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };
    const existingTenant = {
      id: 'tenant-1',
      domain: 'tenant-1.localhost',
      slug: 'ws-1',
      name: 'Workspace 1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let firstInstanceId: string | undefined;

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    const stubAgent = { id: 'agt-oat-1', name: 'Oat', tenantId: 'tenant-1' };
    const stubProvider = { id: 'prv-1', tenantId: 'tenant-1', name: 'granola' };
    const stubCredential = {
      id: 'crd-1',
      tenantId: 'tenant-1',
      name: 'granola',
      secret: 'gk-test',
    };

    // select chain returns owner role so admin check passes
    const adminRoleRows = [{ roleName: 'owner' }];

    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        agent: {
          findFirst: mock(() => Promise.resolve(stubAgent)),
          findMany: mock(() => Promise.resolve([stubAgent])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([])),
        },
        provider: { findFirst: mock(() => Promise.resolve(stubProvider)) },
        credential: {
          findFirst: mock(() => Promise.resolve(stubCredential)),
          findMany: mock(() => Promise.resolve([stubCredential])),
        },
      },
      select: mock(() => makeSelectChain(adminRoleRows)),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app = buildApp(base);
    const body = {
      type: 'oat',
      scope: 'workspace',
      tenantId: 'tenant-1',
      credentialIds: ['crd-1'],
    };

    const res1 = await app.fetch(makeRequest('http://localhost/agents', { method: 'POST', body }));
    expect(res1.status).toBe(201);
    const json1 = await res1.json();
    expect(json1.agentName).toBe('Oat');
    firstInstanceId = json1.instanceId;

    // For idempotency: simulate second call returning the same agent + existing instance
    const existingAgent = { id: json1.agentId, name: 'Oat', tenantId: 'tenant-1' };
    const existingInstance = {
      id: firstInstanceId,
      agentId: json1.agentId,
      tenantId: 'tenant-1',
      address: `${firstInstanceId}@tenant-1.localhost`,
      status: 'deployed',
      principalId: 'prn-agent-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base2: any;
    const txMock2 = mock((fn: (tx: typeof base2) => Promise<unknown>) => fn(base2));
    base2 = {
      transaction: txMock2,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        agent: {
          findFirst: mock(() => Promise.resolve(existingAgent)),
          findMany: mock(() => Promise.resolve([existingAgent])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(existingInstance)),
          findMany: mock(() => Promise.resolve([existingInstance])),
        },
        provider: { findFirst: mock(() => Promise.resolve(stubProvider)) },
        credential: {
          findFirst: mock(() => Promise.resolve(stubCredential)),
          findMany: mock(() => Promise.resolve([stubCredential])),
        },
      },
      select: mock(() => makeSelectChain(adminRoleRows)),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app2 = buildApp(base2);
    const res2 = await app2.fetch(makeRequest('http://localhost/agents', { method: 'POST', body }));
    expect(res2.status).toBe(201);
    const json2 = await res2.json();
    expect(json2.instanceId).toBe(firstInstanceId);
  });

  it('provisionMyra twice for two different principals produces distinct credential names', async () => {
    const TENANT_ID = 'tenant-shared';
    const existingTenant = {
      id: TENANT_ID,
      domain: 'shared.localhost',
      slug: 'ws-shared',
      name: 'Shared Workspace',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const credentialNames: string[] = [];

    function makeMyraDb(userId: string, principalId: string) {
      const existingPrincipal = {
        id: principalId,
        tenantId: TENANT_ID,
        kind: 'user',
        refId: userId,
      };

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let base: any;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
      const stubMyraAgent = {
        id: `agt-myra-${principalId}`,
        name: `myra-${principalId}`,
        tenantId: TENANT_ID,
      };
      const stubMyraProvider = {
        id: `prv-${principalId}`,
        tenantId: TENANT_ID,
        name: 'openai-compatible',
      };
      const stubMyraCredential = {
        id: `crd-${principalId}`,
        tenantId: TENANT_ID,
        name: `myra-llm-${principalId}`,
        secret: 'sk-test',
      };

      base = {
        transaction: txMock,
        query: {
          principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
          tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
          agent: {
            findFirst: mock(() => Promise.resolve(stubMyraAgent)),
            findMany: mock(() => Promise.resolve([stubMyraAgent])),
          },
          agentInstance: {
            findFirst: mock(() => Promise.resolve(undefined)),
            findMany: mock(() => Promise.resolve([])),
          },
          provider: { findFirst: mock(() => Promise.resolve(stubMyraProvider)) },
          credential: { findFirst: mock(() => Promise.resolve(stubMyraCredential)) },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        insert: mock((_table: any) => ({
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          values: mock((row: any) => {
            // Capture credential names when inserting into the credential table
            if (row && row.type === 'api_key') {
              credentialNames.push(row.name as string);
            }
            return {
              returning: mock(() => Promise.resolve([])),
              onConflictDoNothing: mock(() => Promise.resolve([])),
            };
          }),
        })),
        update: mock(() => ({
          set: mock(() => ({ where: mock(() => Promise.resolve()) })),
        })),
      };
      return base;
    }

    const body = {
      type: 'myra',
      scope: 'personal',
      tenantId: TENANT_ID,
      llm: { baseURL: 'https://api.openai.com', apiKey: 'sk-test', model: 'gpt-4o' },
    };

    const app1 = buildApp(makeMyraDb('user-1', 'prn-1'), 'user-1');
    const res1 = await app1.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body, userId: 'user-1' })
    );
    expect(res1.status).toBe(201);

    const app2 = buildApp(makeMyraDb('user-2', 'prn-2'), 'user-2');
    const res2 = await app2.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body, userId: 'user-2' })
    );
    expect(res2.status).toBe(201);

    // Each user should have their own distinct credential name
    const llmCreds = credentialNames.filter((n) => n.startsWith('myra-llm-'));
    expect(llmCreds).toHaveLength(2);
    expect(llmCreds[0]).not.toBe(llmCreds[1]);
  });

  it('POST oat with credentialIds creates grants for each credential and does not insert new credentials', async () => {
    const existingPrincipal = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };
    const existingTenant = {
      id: 'tenant-1',
      domain: 'tenant-1.localhost',
      slug: 'ws-1',
      name: 'Workspace 1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const existingCredential = { id: 'crd-granola', tenantId: 'tenant-1', name: 'granola' };
    const stubAgent = { id: 'agt-oat-1', name: 'Oat', tenantId: 'tenant-1' };

    const credentialInserts: string[] = [];
    const grantInserts: string[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        agent: {
          findFirst: mock(() => Promise.resolve(stubAgent)),
          findMany: mock(() => Promise.resolve([stubAgent])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([])),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: {
          findFirst: mock(() => Promise.resolve(existingCredential)),
          findMany: mock(() => Promise.resolve([existingCredential])),
        },
      },
      select: mock(() => makeSelectChain([{ roleName: 'owner' }])),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      insert: mock((_table: any) => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        values: mock((row: any) => {
          if (row && row.type === 'api_key') credentialInserts.push(row.name as string);
          if (row && row.resource) grantInserts.push(row.resource as string);
          return {
            returning: mock(() => Promise.resolve([])),
            onConflictDoNothing: mock(() => Promise.resolve([])),
          };
        }),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-1',
          credentialIds: ['crd-granola'],
        },
      })
    );
    expect(res.status).toBe(201);
    // No new credential rows should be inserted
    expect(credentialInserts).toHaveLength(0);
    // A grant for the credential should have been written
    expect(grantInserts).toContain('credential:crd-granola');
  });

  it('POST oat returns 400 when credentialIds is empty array', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-1',
          credentialIds: [],
        },
      })
    );
    expect(res.status).toBe(400);
  });

  it('POST oat returns 400 when credentialIds is missing', async () => {
    const existingPrincipal = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };
    const existingTenant = {
      id: 'tenant-1',
      domain: 'tenant-1.localhost',
      slug: 'ws-1',
      name: 'Workspace 1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      select: mock(() => makeSelectChain([{ roleName: 'owner' }])),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-1',
          // credentialIds missing — should fail schema validation
        },
      })
    );
    expect(res.status).toBe(400);
  });

  it('non-admin tenant member gets 403 when provisioning Oat', async () => {
    const existingPrincipal = {
      id: 'prn-member-1',
      tenantId: 'tenant-1',
      kind: 'user',
      refId: 'user-member',
    };
    const existingTenant = {
      id: 'tenant-1',
      domain: 'tenant-1.localhost',
      slug: 'ws-1',
      name: 'Workspace 1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      // No admin/owner roles
      select: mock(() => makeSelectChain([])),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app = buildApp(base, 'user-member');
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        userId: 'user-member',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-1',
          credentialIds: ['crd-1'],
        },
      })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('admin');
  });

  it('second POST for same agent type returns the existing instance (idempotent via check-then-insert)', async () => {
    const existingPrincipal = {
      id: 'prn-owner-1',
      tenantId: 'tenant-2',
      kind: 'user',
      refId: 'user-owner',
    };
    const existingTenant = {
      id: 'tenant-2',
      domain: 'tenant-2.localhost',
      slug: 'ws-2',
      name: 'Workspace 2',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const existingAgentRow = { id: 'agt-oat-2', name: 'Oat', tenantId: 'tenant-2' };
    const existingInstanceRow = {
      id: 'ins-oat-2',
      agentId: 'agt-oat-2',
      tenantId: 'tenant-2',
      address: 'ins-oat-2@tenant-2.localhost',
      status: 'deployed',
      principalId: 'prn-agent-oat-2',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const stubProvider = { id: 'prv-2', tenantId: 'tenant-2', name: 'granola' };
    const stubCredential = { id: 'crd-2', tenantId: 'tenant-2', name: 'granola', secret: 'gk-x' };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        // agent.findFirst returns existing agent — simulates second call
        agent: {
          findFirst: mock(() => Promise.resolve(existingAgentRow)),
          findMany: mock(() => Promise.resolve([existingAgentRow])),
        },
        // agentInstance.findFirst returns existing instance — no new row inserted
        agentInstance: {
          findFirst: mock(() => Promise.resolve(existingInstanceRow)),
          findMany: mock(() => Promise.resolve([existingInstanceRow])),
        },
        provider: { findFirst: mock(() => Promise.resolve(stubProvider)) },
        credential: {
          findFirst: mock(() => Promise.resolve(stubCredential)),
          findMany: mock(() => Promise.resolve([stubCredential])),
        },
      },
      select: mock(() => makeSelectChain([{ roleName: 'owner' }])),
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      })),
    };

    const app = buildApp(base, 'user-owner');
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        userId: 'user-owner',
        body: {
          type: 'oat',
          scope: 'workspace',
          tenantId: 'tenant-2',
          credentialIds: ['crd-2'],
        },
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    // Must return the existing instance id, not a new one
    expect(json.instanceId).toBe('ins-oat-2');
    expect(json.agentId).toBe('agt-oat-2');
  });
});

describe('POST /myra/credential', () => {
  const personalTenant = {
    id: 'tenant-personal',
    slug: 'user-user-1',
    domain: 'user-1.localhost',
    name: 'Personal',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const callerPrincipal = { id: 'prn-user-1', tenantId: 'tenant-personal', kind: 'user', refId: 'user-1' };
  const savedProvider = { id: 'prov-1', name: 'openai-compatible', plugin: 'anthropic', tenantId: 'tenant-personal' };
  const savedCredential = { id: 'cred-1', name: 'myra-llm-prn-user-1', secret: 'sk-test', tenantId: 'tenant-personal' };

  it('returns 404 when personal tenant not found', async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when caller principal not found in personal tenant', async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(personalTenant));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 and creates provider and credential for anthropic', async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(personalTenant));
    db.query.principal.findFirst = mock(() => Promise.resolve(callerPrincipal));
    db.query.provider.findFirst = mock(() => Promise.resolve(savedProvider));
    db.query.credential.findFirst = mock(() => Promise.resolve(savedCredential));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('returns 200 for openai-compatible provider with baseURL', async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(personalTenant));
    db.query.principal.findFirst = mock(() => Promise.resolve(callerPrincipal));
    db.query.provider.findFirst = mock(() => Promise.resolve(savedProvider));
    db.query.credential.findFirst = mock(() => Promise.resolve(savedCredential));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: {
          provider: 'openai-compatible',
          apiKey: 'sk-test',
          model: 'llama-3.1-8b',
          baseURL: 'https://my-endpoint.example.com/v1',
        },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('returns 400 for invalid body', async () => {
    const db = makeMockDb();
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: { provider: 'unknown-provider', apiKey: 'sk-test', model: 'gpt-4o' },
      })
    );
    expect(res.status).toBe(400);
  });
});
