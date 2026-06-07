import { describe, expect, it, mock } from 'bun:test';
import { encryptSecret, parseEncryptionKeys } from '@workbench/hub-crypto';
import * as intxDbReal from '@intx/db';
import type { DB } from '@intx/db';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';

const TEST_CREDENTIAL_KEYS = parseEncryptionKeys(`1:${Buffer.alloc(32, 0x01).toString('base64')}`);
const TEST_TENANT_ID = 'tenant-1';
const TEST_API_KEY = 'sk-test-key';
const TEST_ENCRYPTED_API_KEY = encryptSecret(TEST_CREDENTIAL_KEYS, TEST_TENANT_ID, TEST_API_KEY);

mock.module('../config', () => ({
  getConfig: () => ({
    credentialKeys: TEST_CREDENTIAL_KEYS,
  }),
}));

// Launch outcome is driven by resolveInstanceSources: tests set `sourcesImpl`
// to return sources (launch proceeds) or throw (launch fails). Credential
// repair is exercised in agent-credential-repair.test.ts; stub it here.
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);
let credentialByIdImpl: () => Promise<unknown> = () => Promise.resolve(undefined);
mock.module('@intx/db', () => ({
  ...intxDbReal,
  resolveInstanceSources: () => sourcesImpl(),
  resolveCredentialById: () => credentialByIdImpl(),
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
    createAgentProvisioningRouter(
      db as unknown as DB['db'],
      sessionService,
      mockGrantStore,
      mockSidecarRouter
    )
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
        onConflictDoUpdate: mock(() => onConflictChain),
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

  it('returns 201 with launched:true and creates an agent instance', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve({ capabilities: null })) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

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
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve({ capabilities: null })) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

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
    // insert chain: supports both .onConflictDoUpdate (provider upsert) and .onConflictDoNothing().returning() (credential insert)
    db.insert = mock(() => ({
      values: mock((): any => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        onConflictDoNothing: mock((): any => ({
          returning: mock(() => Promise.resolve([savedCredential])),
        })),
        onConflictDoUpdate: mock((): any => ({
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
    // insert chain: supports both .onConflictDoUpdate (provider upsert) and .onConflictDoNothing().returning() → [] (conflict)
    db.insert = mock(() => ({
      values: mock((): any => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        onConflictDoNothing: mock((): any => ({
          returning: mock(() => Promise.resolve([])),
        })),
        onConflictDoUpdate: mock((): any => ({
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

// ─── PATCH /tenants/:tenantId/credentials/:credentialId ──────────

describe('PATCH /tenants/:tenantId/credentials/:credentialId', () => {
  it('pushes plaintext apiKey (not enc:v1: ciphertext) to the sidecar after credential update', async () => {
    const capturedSendArgs: Parameters<SidecarRouter['sendSourcesUpdate']>[] = [];
    const capturingSidecarRouter: SidecarRouter = {
      ...mockSidecarRouter,
      sendSourcesUpdate: mock((...args: Parameters<SidecarRouter['sendSourcesUpdate']>) => {
        capturedSendArgs.push(args);
        return Promise.resolve();
      }),
    } as unknown as SidecarRouter;

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve({ id: 'crd-1', tenantId: 'tenant-1', providerId: 'prov-1' })
    );
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([
        {
          id: 'ins-1',
          agentId: 'agt-1',
          tenantId: 'tenant-1',
          address: 'ins-1@tenant-1.localhost',
          status: 'running',
        },
      ])
    );

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      await next();
    });
    parent.route(
      '/',
      createAgentProvisioningRouter(
        db as unknown as DB['db'],
        mockSessionService,
        mockGrantStore,
        capturingSidecarRouter
      )
    );

    const res = await parent.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials/crd-1', {
        method: 'PATCH',
        body: { apiKey: 'sk-new-plaintext-key' },
      })
    );

    expect(res.status).toBe(200);

    // Wait a tick for the void-fired promise to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(capturedSendArgs.length).toBeGreaterThan(0);
    const [, pushedSources] = capturedSendArgs[0]!;
    const firstSource = (pushedSources as { apiKey: string }[])[0];
    expect(firstSource?.apiKey).toBe(TEST_API_KEY);
    expect(firstSource?.apiKey).not.toMatch(/^enc:v1:/);
  });
});

// ─── PATCH /tenants/:tenantId/agents/:agentId/credential ─────────

describe('PATCH /tenants/:tenantId/agents/:agentId/credential', () => {
  it('assigns a credential using the agent tenant when the URL tenant is stale', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = makeMockDb({
      update: mock(() => ({
        set: mock((values: Record<string, unknown>) => ({
          where: mock(() => {
            updates.push(values);
            return Promise.resolve();
          }),
        })),
      })),
    });

    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    let agentLookup = 0;
    db.query.agent.findFirst = mock(() => {
      agentLookup += 1;
      if (agentLookup === 1) return Promise.resolve(undefined);
      return Promise.resolve({
        id: 'agt-1',
        tenantId: 'tenant-1',
        credentialRequirements: [],
        modelConfig: null,
      });
    });
    db.query.provider.findFirst = mock(() =>
      Promise.resolve({
        id: 'prov-1',
        name: 'openai-compatible',
        plugin: 'openai-compatible',
        metadata: { model: 'gpt-4o-mini' },
      })
    );
    credentialByIdImpl = () =>
      Promise.resolve({ id: 'crd-1', name: 'Workbench LLM', providerId: 'prov-1' });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/wrong-tenant/agents/agt-1/credential', {
        method: 'PATCH',
        body: { credentialId: 'crd-1' },
      })
    );

    expect(res.status).toBe(200);
    expect(updates[0]?.credentialRequirements).toEqual([
      { source: 'tenant', name: 'Workbench LLM', providerName: 'openai-compatible' },
    ]);
    expect(updates[0]?.modelConfig).toEqual({ defaultModel: 'gpt-4o-mini' });
  });

  it('rejects inference credentials that do not define a model', async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-1',
        tenantId: 'tenant-1',
        credentialRequirements: [],
        modelConfig: null,
      })
    );
    db.query.provider.findFirst = mock(() =>
      Promise.resolve({
        id: 'prov-1',
        name: 'openai-compatible',
        plugin: 'openai-compatible',
        metadata: {},
      })
    );
    credentialByIdImpl = () =>
      Promise.resolve({ id: 'crd-1', name: 'Broken LLM', providerId: 'prov-1' });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/agents/agt-1/credential', {
        method: 'PATCH',
        body: { credentialId: 'crd-1' },
      })
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('model');
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
  });

  it('returns 200 with launched:true immediately when the instance is already running', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: 'running' })
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it('returns 200 with launched:true when launchSession fails because the agent already exists on the sidecar', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

    // In production, the sidecar returns "Agent already exists" wrapped in a
    // provision-phase SessionLaunchError. Simulate that here.
    const provisionError = new SessionLaunchError(
      'provision',
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(provisionError)),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
    expect('launchError' in json).toBe(false);
    // Provision-phase failures must not be retried — one attempt only.
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_ENCRYPTED_API_KEY }]);

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      'ins-1'
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it('decrypts apiKey before passing sources to launchSession', async () => {
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
    const launchArg = (sessionService.launchSession as ReturnType<typeof mock>).mock
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .calls[0]![0] as {
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
