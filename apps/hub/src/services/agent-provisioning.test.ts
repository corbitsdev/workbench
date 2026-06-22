import { describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

const TEST_API_KEY = "sk-test-key";

mock.module("../config", () => ({
  getConfig: () => ({
    globalTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
}));

// Launch outcome is driven by resolveModelSources: tests set `sourcesImpl` to
// return sources (launch proceeds), an empty array (resolution fails with
// no_requirements), or throw (resolution errors). `resolveModelSources` is the
// definition-anchored resolver the launch path uses; it resolves an ancestor-
// owned definition's requirements against the instance tenant. The legacy
// tenant-exact `resolveInstanceModelSources` is driven separately by
// `instanceSourcesImpl` so a test can simulate its tenant-exact miss and prove
// the launch path no longer consults it.
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
let instanceSourcesImpl: (() => Promise<unknown[]>) | null = null;
mock.module("@intx/db", () => ({
  ...intxDbReal,
  resolveModelSources: async (
    _db: unknown,
    _tenantId: unknown,
    _requirements: unknown,
    opts?: { invokerPreferences?: Record<string, unknown> },
  ) => {
    // Stand in for the catalog resolver: a non-empty invoker preference here
    // models a `pin` that excludes every tenant source, so the launch path
    // forwarding the instance's persisted preferences yields no source. This
    // lets a test assert launch *behavior* (fails) rather than the call args.
    if (Object.keys(opts?.invokerPreferences ?? {}).length > 0) {
      return {
        ok: false,
        reason: "model_unavailable",
        model: "deepseek-v4-flash",
        skips: [],
      };
    }
    const sources = await sourcesImpl();
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
  resolveInstanceModelSources: async () => {
    const sources = await (instanceSourcesImpl ?? sourcesImpl)();
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
}));

import {
  launchAgentSession,
  relaunchInstanceIfNeeded,
} from "./agent-provisioning";

const mockSessionService: SessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
  endSession: mock(() => Promise.reject(new Error("not implemented"))),
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
} as unknown as import("@intx/hub-sessions").EventCollectorRegistry;

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

describe("relaunchInstanceIfNeeded", () => {
  const TENANT_ROW = { id: "tenant-1", domain: "tenant-1.localhost" };
  const AGENT_WITH_REQUIREMENT = {
    id: "agt-1",
    systemPrompt: "You are Myra.",
    credentialRequirements: [
      { providerName: "openai-compatible", source: "tenant" },
    ],
    modelRequirements: null,
    grantRequirements: null,
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    toolPackages: [],
  };

  function coldInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: "ins-1@tenant-1.localhost",
      status: "deployed",
      sessionId: null,
      principalId: "prn-agent-1",
      endedAt: null,
      ...overrides,
    };
  }

  it("returns early without launching when the catalog cannot resolve the agent model", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve(AGENT_WITH_REQUIREMENT),
    );
    // Catalog resolution yields no sources (no_requirements) — the guard must
    // short-circuit before launching.
    sourcesImpl = () => Promise.resolve([]);

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(launchSession).not.toHaveBeenCalled();
  });

  it("launches when the catalog resolves the agent model", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve(AGENT_WITH_REQUIREMENT),
    );
    // Catalog resolution returns a source — the guard passes and launch proceeds.
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when the address is already routable on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance()),
    );

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter(["ins-1@tenant-1.localhost"]) as never,
    );

    expect(launchSession).not.toHaveBeenCalled();
  });
});

describe("launchAgentSession retry behavior", () => {
  const BASE_OPTS = {
    agentId: "agt-1",
    instanceId: "ins-1",
    instancePrincipalId: "prn-agent-1",
    tenantId: "tenant-1",
    tenantDomain: "tenant-1.localhost",
    systemPrompt: "You are an agent.",
    now: new Date("2026-01-01T00:00:00Z"),
  };

  function launchDb(toolPackages: unknown[] | null = []) {
    const db = makeMockDb();
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: ["exa_search"] },
        credentialRequirements: null,
        modelRequirements: null,
        grantRequirements: [],
        toolPackages,
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: null }),
    );
    return db;
  }

  it("forwards tool package pins from the agent DB row to launchSession", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const toolPackages = [{ name: "@workbench/tools-exa", version: "^0.1.0" }];

    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const launchSession = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    await launchAgentSession(
      launchDb(toolPackages) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(capturedConfig.toolPackagePins).toEqual(toolPackages);
  });

  it("retries after a transient launch failure and then succeeds", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    let calls = 0;
    const launchSession = mock(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new Error("transient network blip"));
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(result.sessionId).toBeTruthy();
    expect(launchSession).toHaveBeenCalledTimes(2);
  }, 10000);

  it("passes empty toolPackagePins when agent row has null toolPackages", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const launchSession = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    await launchAgentSession(
      launchDb(null) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(capturedConfig.toolPackagePins).toEqual([]);
  });

  it("does not retry a provision-phase failure and rethrows it", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError(
      "provision",
      new Error("rejected"),
      false,
    );
    const launchSession = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        launchDb() as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("launches an instance whose definition lives in an ancestor tenant", async () => {
    // The definition is owned by a parent tenant ("tnt-parent"); the instance
    // launches in the child tenant ("tnt-child"). The tenant-exact resolver
    // (resolveInstanceModelSources) would miss the ancestor-owned definition
    // and report no_requirements; the launch path must instead resolve the
    // definition's requirements against the instance tenant via
    // resolveModelSources, which succeeds.
    instanceSourcesImpl = () => Promise.resolve([]); // tenant-exact miss
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const db = makeMockDb();
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-shared",
        tenantId: "tnt-parent",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: null,
        modelRequirements: [{ model: "deepseek-v4-flash" }],
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-child", sessionId: null }),
    );

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    try {
      const result = await launchAgentSession(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        {
          ...BASE_OPTS,
          agentId: "agt-shared",
          instanceId: "ins-child",
          tenantId: "tnt-child",
          tenantDomain: "tnt-child.localhost",
        },
      );

      expect(result.sessionId).toBeTruthy();
      expect(launchSession).toHaveBeenCalledTimes(1);
    } finally {
      instanceSourcesImpl = null;
    }
  });

  it("resolves using the instance's persisted model preferences", async () => {
    // The instance carries an invoker `pin` preference. The mocked resolver
    // treats any non-empty preference as excluding all sources, so launch must
    // fail — proving the launch path forwards the persisted preferences rather
    // than ignoring them (which would resolve sources and launch successfully).
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const db = makeMockDb();
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: null,
        modelRequirements: [{ model: "deepseek-v4-flash" }],
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        sessionId: null,
        modelPreferences: [
          {
            model: "deepseek-v4-flash",
            providers: { mode: "pin", order: ["nonexistent"] },
          },
        ],
      }),
    );

    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow(/model_unavailable/);
    expect(launchSession).not.toHaveBeenCalled();
  });
});
