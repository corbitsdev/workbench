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
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

function buildApp(db: ReturnType<typeof makeMockDb>, userId = 'user-1') {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route(
    '/',
    createAgentProvisioningRouter(db as never, mockSessionService as never, mockGrantStore as never)
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
    db.query.credential.findMany = mock(() =>
      Promise.resolve([{ id: 'crd-1', tenantId: 'tenant-1' }])
    );
    db.query.agent.findFirst = mock(() => Promise.resolve(conflictingAgent));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(409);
  });

  it('returns 201 and creates agent instance with grants', async () => {
    const stubAgent = {
      id: 'agt-1',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: VALID_BODY.systemPrompt,
    };
    const stubCredential = { id: 'crd-1', tenantId: 'tenant-1', name: 'llm', secret: 'sk-test' };
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
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
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
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.agentName).toBe('Loop');
    expect(json.instanceId).toBeTruthy();
    expect(grantInserts).toContain('credential:crd-1');
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

// ─── POST /myra/credential ────────────────────────────────────────

describe('POST /myra/credential', () => {
  const personalTenant = {
    id: 'tenant-personal',
    slug: 'user-user-1',
    domain: 'user-1.localhost',
    name: 'Personal',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const callerPrincipal = {
    id: 'prn-user-1',
    tenantId: 'tenant-personal',
    kind: 'user',
    refId: 'user-1',
  };
  const savedProvider = {
    id: 'prov-1',
    name: 'openai-compatible',
    plugin: 'anthropic',
    tenantId: 'tenant-personal',
  };
  const savedCredential = {
    id: 'cred-1',
    name: 'myra-llm-prn-user-1',
    secret: 'sk-test',
    tenantId: 'tenant-personal',
  };

  it('returns 404 when personal tenant not found', async () => {
    const app = buildApp(makeMockDb());
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
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/myra/credential', {
        method: 'POST',
        body: { provider: 'unknown-provider', apiKey: 'sk-test', model: 'gpt-4o' },
      })
    );
    expect(res.status).toBe(400);
  });
});
