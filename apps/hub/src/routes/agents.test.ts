import { describe, expect, it, mock } from 'bun:test';
import { parseEncryptionKeys } from '@workbench/hub-crypto';
import * as intxDbReal from '@intx/db';
import type { DB } from '@intx/db';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';

mock.module('../config', () => ({
  getConfig: () => ({
    credentialKeys: parseEncryptionKeys(`1:${Buffer.alloc(32, 0x01).toString('base64')}`),
  }),
}));

// Launch outcome is driven by resolveInstanceSources: tests set `sourcesImpl`
// to return sources (launch proceeds) or throw (launch fails). Credential
// repair is exercised in agent-credential-repair.test.ts; stub it here.
let sourcesImpl: () => Promise<unknown[]> = () => Promise.resolve([{ id: 'src-1' }]);
mock.module('@intx/db', () => ({
  ...intxDbReal,
  resolveInstanceSources: () => sourcesImpl(),
}));
mock.module('../lib/agent-credential-repair', () => ({
  repairTenantAgentCredentials: () => Promise.resolve(),
  repairUserAgentCredentials: () => Promise.resolve(),
}));

import { Hono } from 'hono';
import { createAgentProvisioningRouter, relaunchInstanceIfNeeded } from './agents';

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

const mockSessionService: SessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
  endSession: mock(() => Promise.reject(new Error('not implemented'))),
} as unknown as SessionService;

const mockGrantStore: GrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
};

const mockSidecarRouter: SidecarRouter = {
  sendSourcesUpdate: mock(() => Promise.resolve()),
} as unknown as SidecarRouter;

function buildApp(
  db: ReturnType<typeof makeMockDb>,
  sessionService: SessionService = mockSessionService,
  userId = 'user-1'
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route(
    '/',
    createAgentProvisioningRouter(db as unknown as DB['db'], sessionService, mockGrantStore, mockSidecarRouter)
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
      agentSession: {
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
        body: { tenantId: 'tenant-1', systemPrompt: 'You are Loop.' },
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

  it('returns 201 with launched:true and creates an agent instance', async () => {
    const stubAgent = {
      id: 'agt-1',
      name: 'Loop',
      tenantId: 'tenant-1',
      systemPrompt: VALID_BODY.systemPrompt,
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
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([])),
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1' }]);

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.agentName).toBe('Loop');
    expect(json.instanceId).toBeTruthy();
    expect(json.launched).toBe(true);
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1' }]);

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

  it('returns 404 when instance not found', async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller has no principal in the instance tenant', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 with launched:true on successful session start', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () => Promise.resolve([{ id: 'src-1' }]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
  });

  it('returns 200 with launched:false and launchError when source resolution yields nothing', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    // No resolvable inference sources — launch should fail loudly and surface.
    sourcesImpl = () => Promise.resolve([]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(false);
    expect(json.launchError).toContain('No resolvable inference sources');
  });
});

describe('relaunchInstanceIfNeeded', () => {
  const TENANT_ROW = { id: 'tenant-1', domain: 'tenant-1.localhost' };
  const AGENT_ROW = { id: 'agt-1', systemPrompt: 'You are Myra.' };
  const ACTIVE_CREDENTIAL = { id: 'crd-1', tenantId: 'tenant-1', status: 'active' };

  function runningInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ins-1',
      agentId: 'agt-1',
      tenantId: 'tenant-1',
      address: 'ins-1@tenant-1.localhost',
      status: 'running',
      sessionId: 'ses-1',
      principalId: 'prn-agent-1',
      ...overrides,
    };
  }

  it('does not relaunch when the instance is already running', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(runningInstance()));

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      'ins-1'
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it('relaunches a deployed instance with a stale active session record', async () => {
    const db = makeMockDb();
    // Restart left the row in "deployed" with a stale active session record —
    // the agent was dropped from the sidecar and must be relaunched.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: 'deployed' }))
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: 'ses-1', status: 'active' })
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(ACTIVE_CREDENTIAL));

    sourcesImpl = () => Promise.resolve([{ id: 'src-1' }]);

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      'ins-1'
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it('decrypts encrypted apiKey in sources before passing to launchSession', async () => {
    const { encryptSecret, parseEncryptionKeys } = await import('@workbench/hub-crypto');
    const keys = parseEncryptionKeys(`1:${Buffer.alloc(32, 0x01).toString('base64')}`);
    const encrypted = encryptSecret(keys, 'tenant-1', 'sk-real-key');

    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: 'deployed' }))
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: 'ses-1', status: 'active' })
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(ACTIVE_CREDENTIAL));

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: encrypted }]);

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      'ins-1'
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg = (sessionService.launchSession as ReturnType<typeof mock>).mock.calls[0][0] as {
      config: { sources: { apiKey: string }[] };
    };
    expect(launchArg.config.sources[0]?.apiKey).toBe('sk-real-key');
  });

  it('does not relaunch a non-running instance without an active credential', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: 'deployed' }))
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(undefined));

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      'ins-1'
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });
});
