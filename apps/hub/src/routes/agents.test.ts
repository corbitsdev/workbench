import { describe, expect, it, mock, afterEach } from 'bun:test';
import * as intxDbReal from '@intx/db';
import type { DB } from '@intx/db';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore, GrantRule } from '@intx/types/authz';

const TEST_API_KEY = 'sk-test-key';

mock.module('../config', () => ({
  getConfig: () => ({}),
}));

// Launch outcome is driven by resolveInstanceSources: tests set `sourcesImpl`
// to return sources (launch proceeds) or throw (launch fails).
// CL-1521: sources are now plaintext (stored plaintext in DB, not encrypted).
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);
let credentialByIdImpl: () => Promise<unknown> = () => Promise.resolve(undefined);
mock.module('@intx/db', () => ({
  ...intxDbReal,
  resolveInstanceSources: () => sourcesImpl(),
  resolveCredentialById: () => credentialByIdImpl(),
}));

import { Hono } from 'hono';
import {
  createAgentProvisioningRouter,
  persistInstanceToolGrants,
  relaunchInstanceIfNeeded,
} from './agents';

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

const mockEventCollectors = {
  create: mock(() => {}),
  dispatch: mock(() => {}),
  abandon: mock(() => {}),
  has: mock(() => false),
  getStatus: mock(() => undefined),
  getAccumulatedText: mock(() => undefined),
  getCurrentTurnId: mock(() => undefined),
  getLastTurnId: mock(() => undefined),
} as unknown as import('@intx/hub-sessions').EventCollectorRegistry;

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
      mockSidecarRouter,
      mockEventCollectors
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
  name: 'Workbench 1',
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

  it('excludes removed instances (endedAt set) from the list query', async () => {
    // Search a drizzle SQL condition for a column with the given name. Only
    // descends through queryChunks/arrays — never into a Column's `.table`
    // back-reference, which would otherwise surface every column in the schema.
    // biome-ignore lint/suspicious/noExplicitAny: introspecting drizzle SQL chunks
    function referencesColumn(node: any, columnName: string, seen = new Set()): boolean {
      if (!node || typeof node !== 'object' || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) => referencesColumn(child, columnName, seen));
    }

    const db = makeMockDb({
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        agent: { findMany: mock(() => Promise.resolve([])) },
        agentInstance: { findMany: mock(() => Promise.resolve([])) },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    const app = buildApp(db);
    const res = await app.fetch(makeRequest('http://localhost/agents?tenantId=tenant-1'));
    expect(res.status).toBe(200);

    const findManyArgs = db.query.agentInstance.findMany.mock.calls[0][0];
    expect(referencesColumn(findManyArgs.where, 'ended_at')).toBe(true);
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
        agent: { findFirst: mock(() => Promise.resolve({ id: 'agt-new', capabilities: null })) },
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

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
        agent: { findFirst: mock(() => Promise.resolve({ id: 'agt-new', capabilities: null })) },
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

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

  it('creates a new agent instance on each call', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(TENANT)) },
        agent: { findFirst: mock(() => Promise.resolve({ id: 'agt-new', capabilities: null })) },
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const app = buildApp(base);

    const res1 = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res1.status).toBe(201);
    const json1 = await res1.json();

    const res2 = await app.fetch(
      makeRequest('http://localhost/agents', { method: 'POST', body: VALID_BODY })
    );
    expect(res2.status).toBe(201);
    const json2 = await res2.json();

    expect(json1.instanceId).toBeTruthy();
    expect(json2.instanceId).toBeTruthy();
    expect(json1.instanceId).not.toBe(json2.instanceId);
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
      secret: 'sk-test',
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
  it('stores credential with plaintext apiKey (CL-1521: no encryption)', async () => {
    const updatedRows: Array<Record<string, unknown>> = [];

    // The caller owns crd-1 (creator grant), so the CL-1449 ownership check passes.
    mockGrantStore.collectGrants = mock(() =>
      Promise.resolve([
        {
          id: 'g-crd-1',
          resource: 'credential:crd-1',
          action: '*',
          effect: 'allow',
          origin: 'creator',
          principalId: 'prn-1',
          roleId: null,
          conditions: null,
          expiresAt: null,
        },
      ] satisfies GrantRule[])
    );

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve({ id: 'crd-1', tenantId: 'tenant-1', providerId: 'prov-1' })
    );
    db.update = mock(() => ({
      set: mock((values: Record<string, unknown>) => ({
        where: mock(() => {
          updatedRows.push(values);
          return Promise.resolve();
        }),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials/crd-1', {
        method: 'PATCH',
        body: { apiKey: 'sk-new-plaintext-key' },
      })
    );

    expect(res.status).toBe(200);
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]?.secret).toBe('sk-new-plaintext-key');
    expect((updatedRows[0]?.secret as string).startsWith('enc:')).toBe(false);
  });
});

// ─── Credential listing owner-scoping (CL-1449) ──────────────────

describe('GET/PATCH /tenants/:tenantId/credentials — owner scoping (CL-1449)', () => {
  const CRED_A = {
    id: 'crd-a',
    tenantId: 'tenant-1',
    providerId: 'prov-1',
    name: 'Alice key',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const CRED_B = {
    id: 'crd-b',
    tenantId: 'tenant-1',
    providerId: 'prov-1',
    name: 'Bob key',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const PROVIDER = {
    id: 'prov-1',
    name: 'openai-compatible',
    plugin: 'openai-compatible',
    metadata: { baseURL: 'https://api', model: 'gpt' },
  };

  // A creator grant as written at POST /credentials (agents.ts:419-429).
  function creatorGrant(credId: string, principalId: string): GrantRule {
    return {
      id: `g-${credId}`,
      resource: `credential:${credId}`,
      action: '*',
      effect: 'allow',
      origin: 'creator',
      principalId,
      roleId: null,
      conditions: null,
      expiresAt: null,
    };
  }

  afterEach(() => {
    mockGrantStore.collectGrants = mock(() => Promise.resolve([]));
  });

  it('member A cannot see member B credential in the list (proof-of-fix)', async () => {
    // Alice owns only crd-a (member, no wildcard grant).
    mockGrantStore.collectGrants = mock(() => Promise.resolve([creatorGrant('crd-a', 'prn-1')]));

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.credential.findMany = mock(() => Promise.resolve([CRED_A, CRED_B]));
    db.query.provider.findFirst = mock(() => Promise.resolve(PROVIDER));

    const app = buildApp(db);
    const res = await app.fetch(makeRequest('http://localhost/tenants/tenant-1/credentials'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id);
    expect(ids).toContain('crd-a');
    expect(ids).not.toContain('crd-b');
  });

  it('owner/admin sees all credentials', async () => {
    mockGrantStore.collectGrants = mock(() =>
      Promise.resolve([
        {
          id: 'g-owner',
          resource: '*',
          action: '*',
          effect: 'allow',
          origin: 'system',
          principalId: null,
          roleId: 'rol-owner',
          conditions: null,
          expiresAt: null,
        },
      ] satisfies GrantRule[])
    );

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.credential.findMany = mock(() => Promise.resolve([CRED_A, CRED_B]));
    db.query.provider.findFirst = mock(() => Promise.resolve(PROVIDER));

    const app = buildApp(db);
    const res = await app.fetch(makeRequest('http://localhost/tenants/tenant-1/credentials'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((c) => c.id);
    expect(ids).toContain('crd-a');
    expect(ids).toContain('crd-b');
  });

  it('member A cannot PATCH member B credential', async () => {
    mockGrantStore.collectGrants = mock(() => Promise.resolve([creatorGrant('crd-a', 'prn-1')]));

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.credential.findFirst = mock(() => Promise.resolve(CRED_B));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials/crd-b', {
        method: 'PATCH',
        body: { name: 'hijacked' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('member A can PATCH their own credential', async () => {
    mockGrantStore.collectGrants = mock(() => Promise.resolve([creatorGrant('crd-a', 'prn-1')]));

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.credential.findFirst = mock(() => Promise.resolve(CRED_A));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/credentials/crd-a', {
        method: 'PATCH',
        body: { name: 'renamed' },
      })
    );
    expect(res.status).toBe(200);
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

  it('accepts inference credentials that do not define a model (skips modelConfig update)', async () => {
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

    // The PATCH endpoint is permissive — it adds the credential requirement but
    // silently skips modelConfig when the provider metadata has no model field.
    expect(res.status).toBe(200);
  });
});

// ─── PATCH /tenants/:tenantId/agents/:agentId/tools ──────────────

describe('PATCH /tenants/:tenantId/agents/:agentId/tools', () => {
  it('relaunches running agent instances so updated tools become visible', async () => {
    const sessionService: SessionService = {
      launchSession: mock(() => Promise.resolve()),
      sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
      endSession: mock(() => Promise.resolve()),
    } as unknown as SessionService;

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-1',
        tenantId: 'tenant-1',
        name: 'Loop',
        systemPrompt: 'You are Loop.',
        capabilities: null,
      })
    );
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([
        {
          id: 'ins-1',
          agentId: 'agt-1',
          tenantId: 'tenant-1',
          address: 'ins-1@tenant-1.localhost',
          status: 'running',
          principalId: 'prn-agent-1',
          sessionId: 'ses-1',
        },
      ])
    );
    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/agents/agt-1/tools', {
        method: 'PATCH',
        body: { tools: ['exa_search'] },
      })
    );

    expect(res.status).toBe(200);
    expect(sessionService.endSession).toHaveBeenCalledWith(
      'ins-1@tenant-1.localhost',
      'agent tools updated'
    );
    expect(sessionService.launchSession).toHaveBeenCalled();
  });

  it('skips relaunch when the agent has no systemPrompt', async () => {
    const sessionService: SessionService = {
      launchSession: mock(() => Promise.resolve()),
      sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
      endSession: mock(() => Promise.resolve()),
    } as unknown as SessionService;

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-1',
        tenantId: 'tenant-1',
        name: 'Loop',
        systemPrompt: null,
        capabilities: null,
      })
    );
    db.query.agentInstance.findMany = mock(() => Promise.resolve([]));

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/agents/agt-1/tools', {
        method: 'PATCH',
        body: { tools: ['exa_search'] },
      })
    );

    expect(res.status).toBe(200);
    expect(sessionService.endSession).not.toHaveBeenCalled();
    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it('skips relaunch when the tenant has no domain', async () => {
    const sessionService: SessionService = {
      launchSession: mock(() => Promise.resolve()),
      sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
      endSession: mock(() => Promise.resolve()),
    } as unknown as SessionService;

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve({ id: 'tenant-1', domain: null }));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-1',
        tenantId: 'tenant-1',
        name: 'Loop',
        systemPrompt: 'You are Loop.',
        capabilities: null,
      })
    );
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([
        {
          id: 'ins-1',
          agentId: 'agt-1',
          tenantId: 'tenant-1',
          address: 'ins-1@tenant-1.localhost',
          status: 'running',
          principalId: 'prn-agent-1',
          sessionId: 'ses-1',
        },
      ])
    );

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/agents/agt-1/tools', {
        method: 'PATCH',
        body: { tools: ['exa_search'] },
      })
    );

    expect(res.status).toBe(200);
    expect(sessionService.endSession).not.toHaveBeenCalled();
    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it("only relaunches the edited user's Myra — query is scoped to the patched agent id", async () => {
    // With per-user Myra definitions (CL-1448) each user owns a distinct
    // agentId. The relaunch query filters by that agentId, so editing user A's
    // tools cannot end or relaunch user B's Myra instance.
    function referencesColumn(
      // biome-ignore lint/suspicious/noExplicitAny: where-clause introspection
      node: any,
      columnName: string,
      seen = new Set()
    ): boolean {
      if (!node || typeof node !== 'object' || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) => referencesColumn(child, columnName, seen));
    }

    const sessionService: SessionService = {
      launchSession: mock(() => Promise.resolve()),
      sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
      endSession: mock(() => Promise.resolve()),
    } as unknown as SessionService;

    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-alice',
        tenantId: 'tenant-1',
        name: 'Myra',
        systemPrompt: 'You are Myra.',
        capabilities: null,
      })
    );
    // The real query filters by agentId+status, so it returns only Alice's instance.
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([
        {
          id: 'ins-alice',
          agentId: 'agt-alice',
          tenantId: 'tenant-1',
          address: 'ins-alice@tenant-1.localhost',
          status: 'running',
          principalId: 'prn-agent-alice',
          sessionId: 'ses-alice',
        },
      ])
    );
    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/tenants/tenant-1/agents/agt-alice/tools', {
        method: 'PATCH',
        body: { tools: ['exa_search'] },
      })
    );

    expect(res.status).toBe(200);
    // The relaunch query is scoped to a specific agent id, never all agents.
    const findManyArgs = db.query.agentInstance.findMany.mock.calls.at(-1)?.[0];
    expect(referencesColumn(findManyArgs.where, 'agent_id')).toBe(true);
    // Only Alice's instance is ended/relaunched.
    expect(sessionService.endSession).toHaveBeenCalledTimes(1);
    expect(sessionService.endSession).toHaveBeenCalledWith(
      'ins-alice@tenant-1.localhost',
      'agent tools updated'
    );
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

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

  it('returns 503 with error when source resolution yields nothing', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    // No resolvable inference sources — launch fails and the endpoint surfaces 503.
    sourcesImpl = () => Promise.resolve([]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', { method: 'POST' })
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain('No resolvable inference sources');
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
      mockEventCollectors as never,
      'ins-1',
      { on: () => () => {} } as never
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      { on: () => () => {} } as never
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it('passes plaintext apiKey sources directly to launchSession (CL-1521: no decryption)', async () => {
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

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const sessionService = { ...mockSessionService, launchSession: mock(() => Promise.resolve()) };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      { on: () => () => {} } as never
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg = (sessionService.launchSession as ReturnType<typeof mock>).mock
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .calls[0]![0] as {
      config: { sources: { apiKey: string }[] };
    };
    expect(launchArg.config.sources[0]?.apiKey).toBe(TEST_API_KEY);
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
      mockEventCollectors as never,
      'ins-1',
      { on: () => () => {} } as never
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });
});

// ─── persistInstanceToolGrants ────────────────────────────────────

describe('persistInstanceToolGrants', () => {
  it('inserts grant rows with correct shape for each tool name', async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock })
    );
    const db = { ...makeMockDb(), transaction: txMock } as unknown as import('@intx/db').DB['db'];

    const now = new Date('2026-01-01T00:00:00Z');
    await persistInstanceToolGrants(db, {
      tenantId: 'tenant-1',
      principalId: 'prn-1',
      toolNames: ['exa_search', 'dispatch'],
      now,
    });

    const rows = insertedRows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenantId).toBe('tenant-1');
      expect(row.principalId).toBe('prn-1');
      expect(row.action).toBe('invoke');
      expect(row.effect).toBe('allow');
      expect(row.origin).toBe('system');
      expect(typeof row.resource).toBe('string');
      expect((row.resource as string).startsWith('tool:')).toBe(true);
      expect(row.roleId).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.createdAt).toEqual(now);
      expect(row.updatedAt).toEqual(now);
    }
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain('tool:exa_search');
    expect(resources).toContain('tool:dispatch');
  });

  it('de-duplicates tool names — duplicate entries produce one row per unique name', async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock })
    );
    const db = { ...makeMockDb(), transaction: txMock } as unknown as import('@intx/db').DB['db'];

    await persistInstanceToolGrants(db, {
      tenantId: 'tenant-1',
      principalId: 'prn-1',
      toolNames: ['exa_search', 'exa_search', 'dispatch'],
      now: new Date(),
    });

    const rows = insertedRows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain('tool:exa_search');
    expect(resources).toContain('tool:dispatch');
  });

  it('deletes existing system grants before inserting new ones', async () => {
    const ops: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({
        delete: mock(() => {
          ops.push('delete');
          return { where: mock(() => Promise.resolve()) };
        }),
        insert: mock(() => {
          ops.push('insert');
          return { values: mock(() => Promise.resolve()) };
        }),
      })
    );
    const db = { ...makeMockDb(), transaction: txMock } as unknown as import('@intx/db').DB['db'];

    await persistInstanceToolGrants(db, {
      tenantId: 'tenant-1',
      principalId: 'prn-1',
      toolNames: ['exa_search'],
      now: new Date(),
    });

    expect(ops[0]).toBe('delete');
    expect(ops[1]).toBe('insert');
  });

  it('skips insert but still deletes when toolNames is empty', async () => {
    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock })
    );
    const db = { ...makeMockDb(), transaction: txMock } as unknown as import('@intx/db').DB['db'];

    await persistInstanceToolGrants(db, {
      tenantId: 'tenant-1',
      principalId: 'prn-1',
      toolNames: [],
      now: new Date(),
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
