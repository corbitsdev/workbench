import { describe, expect, it, mock } from 'bun:test';
import * as intxDbReal from '@intx/db';
import type { DB } from '@intx/db';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';

const TEST_API_KEY = 'sk-test-key';

mock.module('../config', () => ({
  getConfig: () => ({}),
}));

// Launch outcome is driven by resolveInstanceSources: tests set `sourcesImpl`
// to return sources (launch proceeds) or throw (launch fails).
// CL-1521: sources are now plaintext (stored plaintext in DB, not encrypted).
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);
mock.module('@intx/db', () => ({
  ...intxDbReal,
  resolveInstanceSources: () => sourcesImpl(),
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
      memberAgentInstance: {
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

const PRINCIPAL = {
  id: 'prn-1',
  tenantId: 'tenant-1',
  kind: 'user',
  refId: 'user-1',
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
        memberAgentInstance: {
          findMany: mock(() => Promise.resolve([])),
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
        memberAgentInstance: { findMany: mock(() => Promise.resolve([])) },
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
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
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
      })
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
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
  });

  it('returns 200 with launched:true when the instance is already running (relaunches to recover after sidecar reconnect)', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: 'running' })
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
    expect(sessionService.launchSession).toHaveBeenCalled();
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
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
      })
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
      makeRequest('http://localhost/instances/ins-1/sessions', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain('No resolvable inference sources');
  });
});

describe('relaunchInstanceIfNeeded', () => {
  const TENANT_ROW = { id: 'tenant-1', domain: 'tenant-1.localhost' };
  const AGENT_ROW = { id: 'agt-1', systemPrompt: 'You are Myra.' };
  const ACTIVE_CREDENTIAL = {
    id: 'crd-1',
    tenantId: 'tenant-1',
    status: 'active',
  };

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

  it('handles "agent already exists" gracefully when instance is running on sidecar', async () => {
    // After a sidecar restart the DB may still show "running" while the sidecar has the agent
    // alive. launchSession throws "Agent already exists for address"; relaunchInstanceIfNeeded
    // must treat that as success rather than surfacing an error.
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(runningInstance()));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() => Promise.resolve(ACTIVE_CREDENTIAL));

    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      // The sidecar wraps the "already exists" error in a provision-phase SessionLaunchError,
      // which breaks the retry loop and propagates to our isAgentAlreadyExistsError check.
      launchSession: mock(() =>
        Promise.reject(
          new SessionLaunchError(
            'provision',
            new Error('Agent already exists for address ins-1@tenant-1.localhost'),
            false
          )
        )
      ),
    };
    // Must not throw — the agent is live, so this is a no-op.
    await expect(
      relaunchInstanceIfNeeded(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        'ins-1',
        { on: () => () => {} } as never
      )
    ).resolves.toBeUndefined();

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
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

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
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

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      { on: () => () => {} } as never
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg =
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (sessionService.launchSession as ReturnType<typeof mock>).mock.calls[0]![0] as {
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

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
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
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import('@intx/db').DB['db'];

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
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import('@intx/db').DB['db'];

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
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import('@intx/db').DB['db'];

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
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import('@intx/db').DB['db'];

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
