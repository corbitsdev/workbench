import { describe, expect, it, mock } from 'bun:test';
import * as intxDbReal from '@intx/db';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';

const TEST_API_KEY = 'sk-test-key';

mock.module('../config', () => ({
  getConfig: () => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  }),
}));

// Launch outcome is driven by resolveInstanceSources: tests set `sourcesImpl`
// to return sources (launch proceeds) or throw (launch fails).
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);
mock.module('@intx/db', () => ({
  ...intxDbReal,
  resolveInstanceSources: () => sourcesImpl(),
}));

import { launchAgentSession, relaunchInstanceIfNeeded } from './agent-provisioning';

const mockSessionService: SessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error('not implemented'))),
  endSession: mock(() => Promise.reject(new Error('not implemented'))),
} as unknown as SessionService;

const mockGrantStore: GrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
};

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

function makeSidecarRouter(routable: string[] = []): SidecarRouter {
  return {
    sendSourcesUpdate: mock(() => Promise.resolve()),
    getRoutableAddresses: mock(() => routable),
    events: { on: () => () => {} },
  } as unknown as SidecarRouter;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeSelectChain(rows: any[] = []) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const wherePromise = Promise.resolve(rows) as Promise<any[]> & {
    limit?: unknown;
  };
  wherePromise.limit = mock(() => Promise.resolve(rows));
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const chain: any = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => wherePromise),
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
      principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
      agent: { findFirst: mock(() => Promise.resolve(undefined)) },
      agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      agentSession: { findFirst: mock(() => Promise.resolve(undefined)) },
      credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      provider: { findFirst: mock(() => Promise.resolve(undefined)) },
    },
    select: mock(() => makeSelectChain([])),
    insert: mock(() => ({ values: mock(() => Promise.resolve()) })),
    update: mock(() => ({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    })),
    delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    ...overrides,
  };
  return base;
}

describe('relaunchInstanceIfNeeded', () => {
  const TENANT_ROW = { id: 'tenant-1', domain: 'tenant-1.localhost' };
  const AGENT_WITH_REQUIREMENT = {
    id: 'agt-1',
    systemPrompt: 'You are Myra.',
    credentialRequirements: [{ providerName: 'openai-compatible', source: 'tenant' }],
  };

  function coldInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ins-1',
      agentId: 'agt-1',
      tenantId: 'tenant-1',
      address: 'ins-1@tenant-1.localhost',
      status: 'deployed',
      sessionId: null,
      principalId: 'prn-agent-1',
      endedAt: null,
      ...overrides,
    };
  }

  it('returns early without launching when a required tenant credential is missing', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(coldInstance()));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_WITH_REQUIREMENT));
    // The provider/credential join returns nothing — no active credential for
    // the required provider, so the launch guard must short-circuit.
    db.select = mock(() => makeSelectChain([]));

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      makeSidecarRouter() as never
    );

    expect(launchSession).not.toHaveBeenCalled();
  });

  it('launches when the required tenant credential is present', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(coldInstance()));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_WITH_REQUIREMENT));
    // The batched provider lookup returns the required provider name.
    db.select = mock(() => makeSelectChain([{ name: 'openai-compatible' }]));
    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      makeSidecarRouter() as never
    );

    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it('does not relaunch when the address is already routable on the sidecar', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(coldInstance()));

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      'ins-1',
      makeSidecarRouter(['ins-1@tenant-1.localhost']) as never
    );

    expect(launchSession).not.toHaveBeenCalled();
  });
});

describe('launchAgentSession retry behavior', () => {
  const BASE_OPTS = {
    agentId: 'agt-1',
    instanceId: 'ins-1',
    instancePrincipalId: 'prn-agent-1',
    tenantId: 'tenant-1',
    tenantDomain: 'tenant-1.localhost',
    systemPrompt: 'You are an agent.',
    now: new Date('2026-01-01T00:00:00Z'),
  };

  function launchDb() {
    const db = makeMockDb();
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: 'agt-1',
        capabilities: { tools: ['exa_search'] },
        grantRequirements: [],
      })
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: 'ins-1', sessionId: null })
    );
    return db;
  }

  it('retries after a transient launch failure and then succeeds', async () => {
    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);
    let calls = 0;
    const launchSession = mock(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('transient network blip'));
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS
    );

    expect(result.sessionId).toBeTruthy();
    expect(launchSession).toHaveBeenCalledTimes(2);
  }, 10000);

  it('does not retry a provision-phase failure and rethrows it', async () => {
    sourcesImpl = () => Promise.resolve([{ id: 'src-1', apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError('provision', new Error('rejected'), false);
    const launchSession = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        launchDb() as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS
      )
    ).rejects.toBe(provisionError);
    expect(launchSession).toHaveBeenCalledTimes(1);
  });
});
