import { describe, expect, it, mock } from 'bun:test';
import { parseEncryptionKeys } from '@workbench/hub-crypto';

mock.module('../config', () => ({
  getConfig: () => ({
    credentialKeys: parseEncryptionKeys(`1:${Buffer.alloc(32, 0x01).toString('base64')}`),
  }),
}));

import { Hono } from 'hono';
import { createAgentProvisioningRouter } from './agents';

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
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const mockSessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
  endSession: mock(() => Promise.reject(new Error('not implemented'))),
};

const mockGrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
};

function buildApp(
  db: ReturnType<typeof makeMockDb>,
  sessionService = mockSessionService,
  userId = 'user-1'
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route(
    '/',
    createAgentProvisioningRouter(db as never, sessionService as never, mockGrantStore as never)
  );
  return parent;
}

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
    select: mock(() => makeSelectChain([])),
    insert: mock(() => {
      const onConflictChain = {
        returning: mock(() => Promise.resolve([])),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const valuesChain: any = {
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => onConflictChain),
      };
      return { values: mock(() => valuesChain) };
    }),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => Promise.resolve()),
    })),
    ...overrides,
  };
  return base;
}

// ─── Shared fixtures ──────────────────────────────────────────────

const TENANT = {
  id: 'tenant-1',
  domain: 'tenant-1.localhost',
  slug: 'ws-1',
  name: 'Workspace 1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = { id: 'prn-1', tenantId: 'tenant-1', kind: 'user', refId: 'user-1' };

const VALID_BODY = {
  tenantId: 'tenant-1',
  name: 'Loop',
  systemPrompt: 'You are Loop, a research agent.',
  credentialIds: ['crd-1'],
};

// ─── GET /agents ──────────────────────────────────────────────────

describe('GET /agents', () => {
  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(makeRequest('http://localhost/agents'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('tenantId');
  });

  it('returns 403 when the caller has no principal in the queried tenant', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(makeRequest('http://localhost/agents?tenantId=tenant-other'));
    expect(res.status).toBe(403);
  });

  it('returns agent list when the caller has a principal in the tenant', async () => {
    const instance = {
      id: 'ins-1',
      agentId: 'agt-1',
      tenantId: 'tenant-1',
      address: 'ins-1@tenant-1.localhost',
      status: 'deployed',
      principalId: 'prn-agent-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const agentRow = { id: 'agt-1', name: 'Loop', tenantId: 'tenant-1' };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: {
          findFirst: mock(() => Promise.resolve(agentRow)),
          findMany: mock(() => Promise.resolve([agentRow])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([instance])),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: mock(() => ({
        values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
      delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    };

    const app = buildApp(base);
    const res = await app.fetch(makeRequest('http://localhost/agents?tenantId=tenant-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].agentName).toBe('Loop');
  });
});

// ─── POST /agents ─────────────────────────────────────────────────

describe('POST /agents', () => {
  it('returns 400 when body is invalid (missing name)', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: { tenantId: 'tenant-1', systemPrompt: 'You are Loop.', credentialIds: ['crd-1'] },
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when credentialIds is empty', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/agents', {
        method: 'POST',
        body: { ...VALID_BODY, credentialIds: [] },
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller has no principal in the tenant', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when tenant not found', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(404);
  });

  it('returns 422 when a credential is not found in the tenant', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.credential.findMany = mock(() => Promise.resolve([]));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(422);
  });

  it('returns 409 when the same agent name exists with a different system prompt', async () => {
    const conflictingAgent = {
      id: 'agt-existing',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: 'A different prompt entirely.',
    };
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve({ id: 'crd-1', tenantId: 'tenant-1' })
    );
    db.query.agent.findFirst = mock(() => Promise.resolve(conflictingAgent));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(409);
  });

  it('returns 201 with launched:true and creates agent instance with grants', async () => {
    const stubAgent = {
      id: 'agt-1',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: VALID_BODY.systemPrompt,
    };
    const stubProvider = {
      id: 'prov-1',
      tenantId: 'tenant-1',
      plugin: 'anthropic',
      name: 'anthropic',
      metadata: { baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    };
    const stubCredential = {
      id: 'crd-1',
      tenantId: 'tenant-1',
      name: 'llm',
      providerId: 'prov-1',
      secret: 'enc:sk-test',
    };
    const grantInserts: string[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve(stubAgent)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: {
          findFirst: mock(() => Promise.resolve(stubCredential)),
          findMany: mock(() => Promise.resolve([stubCredential])),
        },
        provider: { findFirst: mock(() => Promise.resolve(stubProvider)) },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      insert: mock((_table: any) => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        values: mock((row: any) => {
          if (row?.resource) grantInserts.push(row.resource as string);
          return {
            returning: mock(() => Promise.resolve([])),
            onConflictDoNothing: mock(() => Promise.resolve([])),
          };
        }),
      })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) })),
      delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.agentName).toBe('Loop');
    expect(json.instanceId).toBeTruthy();
    expect(json.launched).toBe(true);
    expect(grantInserts).toContain('credential:crd-1');
  });

  it('returns 201 with launched:false and launchError when session launch fails', async () => {
    const stubAgent = {
      id: 'agt-1',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: VALID_BODY.systemPrompt,
    };
    const stubProvider = {
      id: 'prov-1',
      tenantId: 'tenant-1',
      plugin: 'anthropic',
      name: 'anthropic',
      metadata: { baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    };
    const stubCredential = {
      id: 'crd-1',
      tenantId: 'tenant-1',
      name: 'llm',
      providerId: 'prov-1',
      secret: 'enc:sk-test',
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve(stubAgent)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: {
          findFirst: mock(() => Promise.resolve(stubCredential)),
          findMany: mock(() => Promise.resolve([stubCredential])),
        },
        provider: { findFirst: mock(() => Promise.resolve(stubProvider)) },
      },
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) })),
      delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    };

    const failingService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(new Error('sidecar not connected'))),
    };

    const app = buildApp(base, failingService);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.launched).toBe(false);
    expect(typeof json.launchError).toBe('string');
    expect(json.launchError).toContain('sidecar not connected');
  });

  it('is idempotent — second call returns the same instance', async () => {
    const stubAgent = {
      id: 'agt-loop',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: VALID_BODY.systemPrompt,
    };
    const existingInstance = {
      id: 'ins-loop',
      agentId: 'agt-loop',
      tenantId: 'tenant-1',
      address: 'ins-loop@tenant-1.localhost',
      status: 'deployed',
      principalId: 'prn-agent-loop',
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
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve(stubAgent)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(existingInstance)) },
        credential: {
          findFirst: mock(() =>
            Promise.resolve({ id: 'crd-1', tenantId: 'tenant-1', name: 'llm', secret: 'x' })
          ),
          findMany: mock(() =>
            Promise.resolve([{ id: 'crd-1', tenantId: 'tenant-1', name: 'llm', secret: 'x' }])
          ),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        })),
      })),
      update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) })),
      delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.instanceId).toBe('ins-loop');
  });
});

// ─── POST /tenants/:tenantId/credentials ──────────────────────────

describe('POST /tenants/:tenantId/credentials', () => {
  const CRED_BODY = {
    provider: 'anthropic',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    name: 'My Anthropic Key',
  };

  it('returns 400 when body is missing required fields', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials', {
        method: 'POST',
        body: { provider: 'anthropic', apiKey: 'sk-test' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller has no principal in the tenant', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials', {
        method: 'POST',
        body: CRED_BODY,
      })
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when tenant not found', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials', {
        method: 'POST',
        body: CRED_BODY,
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 201 with credentialId and providerId on success', async () => {
    const savedProvider = {
      id: 'prov-1',
      name: 'anthropic',
      plugin: 'anthropic',
      tenantId: 'tenant-1',
    };
    const savedCredential = {
      id: 'cred-new',
      name: 'My Anthropic Key',
      secret: 'enc:v1:...',
      tenantId: 'tenant-1',
    };

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.provider.findFirst = mock(() => Promise.resolve(savedProvider));
    // insert chain: .values().onConflictDoNothing().returning() → [savedCredential] (success)
    db.insert = mock(() => ({
      values: mock(() => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        onConflictDoNothing: mock((): any => ({
          returning: mock(() => Promise.resolve([savedCredential])),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials', {
        method: 'POST',
        body: CRED_BODY,
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.credentialId).toBe('cred-new');
    expect(json.providerId).toBe('prov-1');
  });

  it('returns 409 when a credential with the same name already exists', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.provider.findFirst = mock(() =>
      Promise.resolve({
        id: 'prov-1',
        name: 'anthropic',
        plugin: 'anthropic',
        tenantId: 'tenant-1',
      })
    );
    // insert chain: .values().onConflictDoNothing().returning() → [] (conflict)
    db.insert = mock(() => ({
      values: mock(() => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        onConflictDoNothing: mock((): any => ({
          returning: mock(() => Promise.resolve([])),
        })),
      })),
    }));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials', {
        method: 'POST',
        body: CRED_BODY,
      })
    );
    expect(res.status).toBe(409);
  });
});

// ─── POST /instances/:instanceId/sessions ────────────────────────

describe('POST /instances/:instanceId/sessions', () => {
  const INSTANCE = {
    id: 'ins-1',
    agentId: 'agt-1',
    tenantId: 'tenant-1',
    address: 'ins-1@tenant-1.localhost',
    status: 'deployed',
    principalId: 'prn-agent-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const AGENT_ROW = {
    id: 'agt-1',
    name: 'Loop',
    tenantId: 'tenant-1',
    systemPrompt: 'You are Loop.',
  };

  it('returns 400 when body is invalid', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: {},
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when instance not found', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: { credentialIds: ['crd-1'] },
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller has no principal in the instance tenant', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: { credentialIds: ['crd-1'] },
      })
    );
    expect(res.status).toBe(403);
  });

  it('returns 422 when credentials not found in tenant', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findMany = mock(() => Promise.resolve([]));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: { credentialIds: ['crd-missing'] },
      })
    );
    expect(res.status).toBe(422);
  });

  it('returns 200 with launched:true on successful session start', async () => {
    const stubProvider = {
      id: 'prov-1',
      tenantId: 'tenant-1',
      plugin: 'anthropic',
      name: 'anthropic',
      metadata: { baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    };
    const cred = {
      id: 'crd-1',
      tenantId: 'tenant-1',
      name: 'llm',
      providerId: 'prov-1',
      secret: 'enc:sk-test',
    };

    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(cred));
    db.query.credential.findMany = mock(() => Promise.resolve([cred]));
    db.query.provider.findFirst = mock(() => Promise.resolve(stubProvider));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: { credentialIds: ['crd-1'] },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
  });

  it('returns 200 with launched:false and launchError when session launch fails', async () => {
    const stubProvider = {
      id: 'prov-1',
      tenantId: 'tenant-1',
      plugin: 'anthropic',
      name: 'anthropic',
      metadata: { baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    };
    const cred = {
      id: 'crd-1',
      tenantId: 'tenant-1',
      name: 'llm',
      providerId: 'prov-1',
      secret: 'enc:sk-test',
    };

    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(cred));
    db.query.credential.findMany = mock(() => Promise.resolve([cred]));
    db.query.provider.findFirst = mock(() => Promise.resolve(stubProvider));

    const failingService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(new Error('sidecar offline'))),
    };

    const app = buildApp(db, failingService);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
        body: { credentialIds: ['crd-1'] },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(false);
    expect(json.launchError).toContain('sidecar offline');
  });
});
