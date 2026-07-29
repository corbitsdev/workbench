import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { SessionService, SidecarRouter } from "@workbench/hub-sessions";
import { SessionLaunchError } from "@workbench/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

const TEST_API_KEY = "sk-test-key";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
    // launchAgentSession now resolves sources through the CL-2760 catalog cache
    // (CL-2804); it reads this TTL.
    workflowDeploy: { modelSourceCacheTtlMs: 45_000 },
  }),
  enabledUserOAuthInferenceProviders: () => [],
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
    _creatorGrants: unknown,
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

// Spy the native deployment-projection writer at the module boundary so the
// launch-wiring test asserts the seam is exercised without needing a real DB.
const writeInstanceDeploymentProjectionSpy = mock(() => Promise.resolve());
mock.module("./workflow-deploy", () => ({
  writeInstanceDeploymentProjection: writeInstanceDeploymentProjectionSpy,
}));

import {
  launchAgentSession,
  relaunchInstanceIfNeeded,
  isMailReady,
  isAddressRoutable,
  isDeliveryReady,
  ensureMailReadyOnLiveInstance,
} from "./agent-provisioning";
import {
  resetRelaunchBreaker,
  setRelaunchBreakerClock,
} from "./relaunch-breaker";
import { resetWorkflowModelSourceCache } from "./workflow-model-source-cache";

// The launch path now memoizes catalog resolution (CL-2804). Clear it between
// tests so a resolution cached under one test's sourcesImpl cannot leak into the
// next (same tenant + requirements + no invoker prefs would otherwise hit).
beforeEach(() => {
  resetWorkflowModelSourceCache();
});

const mockSessionService: SessionService = {
  deployInstanceAtHead: mock(() => Promise.resolve({ publicKey: "pk" })),
  sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
  endSession: mock(() => Promise.reject(new Error("not implemented"))),
} as unknown as SessionService;

const mockGrantStore: GrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
  collectGrantsInChain: mock(() => Promise.resolve([])),
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
} as unknown as import("@workbench/hub-sessions").EventCollectorRegistry;

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
      memberAgentInstance: {
        findFirst: mock(() => Promise.resolve(undefined)),
      },
      memberPreferences: {
        findFirst: mock(() => Promise.resolve(undefined)),
      },
      // The launch source-resolution path collects the definition creator's
      // grants (credential-use authorization); the grant store reads these.
      principalRole: { findMany: mock(() => Promise.resolve([])) },
      grant: { findMany: mock(() => Promise.resolve([])) },
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

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(deployInstanceAtHead).not.toHaveBeenCalled();
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

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when the address is already routable on the sidecar", async () => {
    const db = makeMockDb();
    // Mail-ready + routable: pure no-op (no deploy, no heal writes).
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(
        coldInstance({ status: "running", sessionId: "ses-live" }),
      ),
    );

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };
    const insert = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.insert = insert;

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter(["ins-1@tenant-1.localhost"]) as never,
    );

    expect(deployInstanceAtHead).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("heals mail-ready when routable but status/sessionId drifted (CL-4688)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance({ status: "deployed", sessionId: null })),
    );
    db.query.agentSession.findFirst = mock(() => Promise.resolve(undefined));

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };
    const insertValues = mock(() => Promise.resolve());
    db.insert = mock(() => ({ values: insertValues }));
    const setMock = mock((set: Record<string, unknown>) => {
      // Re-read after heal must see the persisted sessionId (DB authority).
      if (typeof set.sessionId === "string") {
        db.query.agentInstance.findFirst = mock(() =>
          Promise.resolve(
            coldInstance({
              status: "running",
              sessionId: set.sessionId as string,
            }),
          ),
        );
      }
      return { where: mock(() => Promise.resolve()) };
    });
    db.update = mock(() => ({ set: setMock }));

    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter(["ins-1@tenant-1.localhost"]) as never,
    );

    expect(deployInstanceAtHead).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalled();
    const runningUpdate = setMock.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === "running",
    );
    expect(runningUpdate).toBeTruthy();
  });

  it("bounds launch attempts across repeated polls while launch keeps failing", async () => {
    resetRelaunchBreaker();
    let nowMs = 10_000_000;
    setRelaunchBreakerClock(() => nowMs);

    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve(AGENT_WITH_REQUIREMENT),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // Non-retryable so each launchAgentSession maps to exactly one deployInstanceAtHead
    // call (no internal retry/backoff sleeps) — keeps the assertion at the
    // relaunch granularity the breaker bounds.
    const deployInstanceAtHead = mock(() =>
      Promise.reject(
        new SessionLaunchError(
          "provision",
          new Error("launch keeps failing"),
          false,
        ),
      ),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    // 100 client polls, 1s apart. Without the breaker this launches 100 times;
    // with it, the failure cooldown bounds attempts to the backoff tiers.
    for (let i = 0; i < 100; i++) {
      nowMs += 1_000;
      await relaunchInstanceIfNeeded(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        "ins-1",
        makeSidecarRouter() as never,
      ).catch(() => {});
    }

    expect(deployInstanceAtHead.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(deployInstanceAtHead.mock.calls.length).toBeLessThanOrEqual(5);
    resetRelaunchBreaker();
  });

  it("coalesces concurrent relaunches onto a single launch", async () => {
    resetRelaunchBreaker();

    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(coldInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve(AGENT_WITH_REQUIREMENT),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    let resolveLaunch: () => void = () => {};
    const deployInstanceAtHead = mock(
      () =>
        new Promise<{ publicKey: string }>((resolve) => {
          resolveLaunch = () => resolve({ publicKey: "pk" });
        }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    const a = relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    const b = relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    // Let both calls' async guard chains resolve and reach the coalescing
    // point (a macrotask flush drains the immediately-resolved db-mock awaits).
    await new Promise((r) => setTimeout(r, 0));
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);

    resolveLaunch();
    await Promise.all([a, b]);
    resetRelaunchBreaker();
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

  it("forwards tool package pins from the agent DB row to deployInstanceAtHead", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const toolPackages = [{ name: "@workbench/tools-exa", version: "^0.1.0" }];

    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const deployInstanceAtHead = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

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
    const deployInstanceAtHead = mock(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new Error("transient network blip"));
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(result.sessionId).toBeTruthy();
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(2);
  }, 10000);

  it("passes empty toolPackagePins when agent row has null toolPackages", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const deployInstanceAtHead = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

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
    const deployInstanceAtHead = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await expect(
      launchAgentSession(
        launchDb() as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
  });

  it("treats already-exists as success and returns the DB sessionId (CL-4688)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError(
      "provision",
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false,
    );
    const deployInstanceAtHead = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    const db = launchDb();
    // After mark-running, a concurrent heal may have repointed sessionId.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-from-heal" }),
    );

    const create = mock(() => {});
    const has = mock(() => false);
    const collectors = { ...mockEventCollectors, create, has };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      collectors as never,
      BASE_OPTS,
    );

    expect(result.sessionId).toBe("ses-from-heal");
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
    // Missing collector is created with the authoritative (re-read) sessionId.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.any(String),
      "tenant-1",
      "ses-from-heal",
      "ins-1",
    );
  });

  it("treats already-exists as success and falls back to the launch sessionId when re-read is empty", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError(
      "provision",
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false,
    );
    const deployInstanceAtHead = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    // launchDb re-read returns null sessionId — fall back to the mint.
    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
  });

  it("does not abandon a live event collector on already-exists (CL-4688)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError(
      "provision",
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false,
    );
    const deployInstanceAtHead = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    const create = mock(() => {});
    const has = mock(() => true);
    const collectors = { ...mockEventCollectors, create, has };

    await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      collectors as never,
      BASE_OPTS,
    );

    // Reconnect ownership: live collector must not be replaced mid-turn.
    expect(create).not.toHaveBeenCalled();
  });

  it("writes the native deployment projection after a successful single-agent deploy", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    writeInstanceDeploymentProjectionSpy.mockClear();
    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(writeInstanceDeploymentProjectionSpy).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: reading the spy call arg
    const arg = (writeInstanceDeploymentProjectionSpy.mock.calls[0] as any)[0];
    expect(arg).toMatchObject({
      instanceAddress: "ins-1@tenant-1.localhost",
      agentId: "agt-1",
      tenantId: "tenant-1",
      creatorPrincipalId: "prn-agent-1",
    });
  });

  it("does not write the projection when the deploy fails on every attempt", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    writeInstanceDeploymentProjectionSpy.mockClear();
    const provisionError = new SessionLaunchError(
      "provision",
      new Error("rejected"),
      false,
    );
    const deployInstanceAtHead = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await expect(
      launchAgentSession(
        launchDb() as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);
    expect(writeInstanceDeploymentProjectionSpy).not.toHaveBeenCalled();
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

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

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
      expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
    } finally {
      instanceSourcesImpl = null;
    }
  });

  it("deletes pre-existing session_asset rows before launching the session", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionAsset = intxDbReal.schema.sessionAsset;
    const order: string[] = [];
    const deletedTables: unknown[] = [];

    const db = launchDb();
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      order.push(table === sessionAsset ? "delete-asset" : "delete-other");
      return { where: mock(() => Promise.resolve()) };
    });

    const deployInstanceAtHead = mock(() => {
      order.push("launch");
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(deletedTables).toContain(sessionAsset);
    expect(order.indexOf("delete-asset")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("delete-asset")).toBeLessThan(order.indexOf("launch"));
    expect(deployInstanceAtHead).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBeTruthy();
  });

  it("clears session_asset once, outside the retry loop, so a retry does not re-delete", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionAsset = intxDbReal.schema.sessionAsset;
    let assetDeletes = 0;

    const db = launchDb();
    db.delete = mock((table: unknown) => {
      if (table === sessionAsset) assetDeletes += 1;
      return { where: mock(() => Promise.resolve()) };
    });

    let calls = 0;
    const deployInstanceAtHead = mock(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new Error("transient network blip"));
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(deployInstanceAtHead).toHaveBeenCalledTimes(2);
    expect(assetDeletes).toBe(1);
  }, 10000);

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

    const deployInstanceAtHead = mock(() =>
      Promise.resolve({ publicKey: "pk" }),
    );
    const sessionService = { ...mockSessionService, deployInstanceAtHead };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow(/model_unavailable/);
    expect(deployInstanceAtHead).not.toHaveBeenCalled();
  });
});

describe("launchAgentSession timezone marker stamping", () => {
  const BASE_OPTS = {
    agentId: "agt-1",
    instanceId: "ins-1",
    instancePrincipalId: "prn-agent-1",
    tenantId: "tenant-1",
    tenantDomain: "tenant-1.localhost",
    systemPrompt: "You are an agent.",
    now: new Date("2026-07-15T02:00:00Z"),
  };

  function launchDb() {
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
        toolPackages: [],
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: null }),
    );
    return db;
  }

  // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
  async function captureLaunchPrompt(db: any): Promise<string> {
    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const deployInstanceAtHead = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };
    await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    return capturedConfig.config.systemPrompt as string;
  }

  it("stamps the owning member's stored timezone as a prompt marker", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
      }),
    );
    db.query.memberPreferences.findFirst = mock(() =>
      Promise.resolve({
        preferences: { timezone: "America/Los_Angeles" },
      }),
    );

    const prompt = await captureLaunchPrompt(db);
    expect(prompt).toContain("<!-- workbench:timezone=America/Los_Angeles -->");
  });

  it("stamps no marker when the member has no stored timezone (harness labels UTC)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
      }),
    );

    const prompt = await captureLaunchPrompt(db);
    expect(prompt).not.toContain("workbench:timezone");
  });

  it("stamps no marker for an instance with no owning member mapping", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const prompt = await captureLaunchPrompt(launchDb());
    expect(prompt).not.toContain("workbench:timezone");
  });
});

describe("launchAgentSession Myra personalization style overlay", () => {
  const BASE_OPTS = {
    agentId: "agt-1",
    instanceId: "ins-1",
    instancePrincipalId: "prn-agent-1",
    tenantId: "tenant-1",
    tenantDomain: "tenant-1.localhost",
    systemPrompt: "You are Myra.",
    now: new Date("2026-07-15T02:00:00Z"),
  };

  function launchDb() {
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
        toolPackages: [],
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: null }),
    );
    return db;
  }

  // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
  async function captureLaunchPrompt(db: any): Promise<string> {
    // biome-ignore lint/suspicious/noExplicitAny: capturing launch config
    let capturedConfig: any;
    const deployInstanceAtHead = mock((config: unknown) => {
      capturedConfig = config;
      return Promise.resolve({ publicKey: "pk" });
    });
    const sessionService = { ...mockSessionService, deployInstanceAtHead };
    await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    return capturedConfig.config.systemPrompt as string;
  }

  it("leaves the prompt byte-identical when the member has no stored style selection", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
        templateKey: "myra",
      }),
    );
    db.query.myraVariantPreference = {
      findFirst: mock(() => Promise.resolve(undefined)),
    };

    const prompt = await captureLaunchPrompt(db);
    expect(prompt).toBe("You are Myra.");
  });

  it("leaves the prompt byte-identical for a non-Myra instance regardless of stored selections", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
        templateKey: "oat",
      }),
    );
    db.query.myraVariantPreference = {
      findFirst: mock(() => Promise.resolve({ personality: "candid" })),
    };

    const prompt = await captureLaunchPrompt(db);
    expect(prompt).toBe("You are Myra.");
  });

  it("runs the personalization, style, pinned-skills, and timezone lookups concurrently (CL-3799)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    const DELAY_MS = 60;
    const delay = () => new Promise((resolve) => setTimeout(resolve, DELAY_MS));

    // `memberAgentInstance.findFirst` is independently awaited by the style
    // overlay, the pinned-skills overlay, and the member-timezone lookup in
    // `launchAgentSession` — three separate call sites, none of which reads
    // another's result. Serial execution (the pre-fix code) pays this delay
    // three times; concurrent execution (Promise.allSettled) pays it once.
    db.query.memberAgentInstance.findFirst = mock(async () => {
      await delay();
      return {
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
        templateKey: "myra",
      };
    });
    db.query.myraVariantPreference = {
      findFirst: mock(() => Promise.resolve(undefined)),
    };

    const start = performance.now();
    await captureLaunchPrompt(db);
    const elapsed = performance.now() - start;

    // Three serial 60ms round trips would take ~180ms; concurrent, ~60ms.
    // A generous threshold below the serial sum proves they overlap.
    expect(elapsed).toBeLessThan(DELAY_MS * 2.5);
  });

  it("appends the style overlay section after the base prompt for a Myra chat instance", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
        templateKey: "myra",
      }),
    );
    db.query.myraVariantPreference = {
      findFirst: mock(() =>
        Promise.resolve({ personality: "candid", artifactUsageChat: "none" }),
      ),
    };

    const prompt = await captureLaunchPrompt(db);
    expect(prompt.startsWith("You are Myra.\n\n")).toBe(true);
    expect(prompt).toContain(
      "Be blunt and direct — say the hard thing plainly, skip diplomatic softening.",
    );
    expect(prompt).toContain(
      "Do not create artifacts; deliver results in the reply.",
    );
  });

  it("appends the triage usage axis (not the chat axis) for a Myra triage instance", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.memberAgentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "mai-1",
        tenantId: "tenant-1",
        memberPrincipalId: "prn-member-1",
        instanceId: "ins-1",
        templateKey: "myra-triage",
      }),
    );
    db.query.myraVariantPreference = {
      findFirst: mock(() =>
        Promise.resolve({
          artifactUsageChat: "none",
          artifactUsageTriage: "heavy",
        }),
      ),
    };

    const prompt = await captureLaunchPrompt(db);
    expect(prompt).toContain("Create an artifact for any substantial output");
    expect(prompt).not.toContain(
      "Do not create artifacts; deliver results in the reply.",
    );
  });
});

describe("isMailReady / ensureMailReadyOnLiveInstance (CL-4688 / CL-4689)", () => {
  it("isMailReady requires running status and a truthy sessionId", () => {
    expect(isMailReady({ status: "running", sessionId: "ses-1" })).toBe(true);
    expect(isMailReady({ status: "deployed", sessionId: "ses-1" })).toBe(false);
    expect(isMailReady({ status: "running", sessionId: null })).toBe(false);
    expect(isMailReady({ status: "running", sessionId: undefined })).toBe(
      false,
    );
    // Interchange mail uses `!sessionId` — empty string must not count as ready.
    expect(isMailReady({ status: "running", sessionId: "" })).toBe(false);
  });

  it("isAddressRoutable / isDeliveryReady combine mail-ready with sidecar liveness", () => {
    const live = {
      status: "running",
      sessionId: "ses-1",
      address: "myra@tenant.workbench.local",
    };
    const router = {
      getRoutableAddresses: () => [live.address],
    };
    expect(isAddressRoutable(live.address, router)).toBe(true);
    expect(isDeliveryReady(live, router)).toBe(true);
    expect(isDeliveryReady({ ...live, status: "deployed" }, router)).toBe(
      false,
    );
    expect(isDeliveryReady(live, { getRoutableAddresses: () => [] })).toBe(
      false,
    );
  });

  it("ensureMailReadyOnLiveInstance is a no-op when already mail-ready", async () => {
    const db = makeMockDb();
    const insert = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.insert = insert;
    const sessionId = await ensureMailReadyOnLiveInstance(db as never, {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      principalId: "prn-1",
      status: "running",
      sessionId: "ses-live",
    });
    expect(sessionId).toBe("ses-live");
    expect(insert).not.toHaveBeenCalled();
  });

  it("ensureMailReadyOnLiveInstance refuses deleted instances", async () => {
    const db = makeMockDb();
    await expect(
      ensureMailReadyOnLiveInstance(db as never, {
        id: "ins-1",
        agentId: "agt-1",
        tenantId: "tenant-1",
        principalId: "prn-1",
        status: "stopped",
        sessionId: "ses-1",
        endedAt: new Date(),
      }),
    ).rejects.toThrow(/deleted instance/);
  });

  it("ensureMailReadyOnLiveInstance remints when status drifted and session is ended", async () => {
    const db = makeMockDb();
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-dead", status: "ended" }),
    );
    const insertValues = mock(() => Promise.resolve());
    db.insert = mock(() => ({ values: insertValues }));
    let writtenSessionId: string | undefined;
    const setMock = mock((set: Record<string, unknown>) => {
      writtenSessionId = set.sessionId as string;
      db.query.agentInstance.findFirst = mock(() =>
        Promise.resolve({ id: "ins-1", sessionId: writtenSessionId }),
      );
      return { where: mock(() => Promise.resolve()) };
    });
    db.update = mock(() => ({ set: setMock }));

    const sessionId = await ensureMailReadyOnLiveInstance(db as never, {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      principalId: "prn-1",
      // Not mail-ready yet (status ≠ running), so ended-session remint runs.
      status: "deployed",
      sessionId: "ses-dead",
    });

    expect(insertValues).toHaveBeenCalled();
    expect(sessionId).not.toBe("ses-dead");
    expect(sessionId).toBe(writtenSessionId);
    expect(setMock).toHaveBeenCalled();
    const setArg = setMock.mock.calls[0]![0] as {
      status: string;
      sessionId: string;
    };
    expect(setArg.status).toBe("running");
    expect(setArg.sessionId).toBe(sessionId);
  });

  it("ensureMailReadyOnLiveInstance mints a session and sets running when drifted", async () => {
    const db = makeMockDb();
    db.query.agentSession.findFirst = mock(() => Promise.resolve(undefined));
    const insertValues = mock(() => Promise.resolve());
    db.insert = mock(() => ({ values: insertValues }));
    let writtenSessionId: string | undefined;
    const setMock = mock((set: Record<string, unknown>) => {
      writtenSessionId = set.sessionId as string;
      db.query.agentInstance.findFirst = mock(() =>
        Promise.resolve({ id: "ins-1", sessionId: writtenSessionId }),
      );
      return { where: mock(() => Promise.resolve()) };
    });
    db.update = mock(() => ({ set: setMock }));

    const sessionId = await ensureMailReadyOnLiveInstance(db as never, {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      principalId: "prn-1",
      status: "deployed",
      sessionId: null,
    });

    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(insertValues).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalled();
    const setArg = setMock.mock.calls[0]![0] as {
      status: string;
      sessionId: string;
    };
    expect(setArg.status).toBe("running");
    expect(setArg.sessionId).toBe(sessionId);
  });

  it("ensureMailReadyOnLiveInstance returns the row's sessionId after concurrent overwrite", async () => {
    const db = makeMockDb();
    db.query.agentSession.findFirst = mock(() => Promise.resolve(undefined));
    db.insert = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.update = mock(() => ({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    }));
    // Concurrent heal wrote a different sessionId last.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-from-other-heal" }),
    );

    const sessionId = await ensureMailReadyOnLiveInstance(db as never, {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      principalId: "prn-1",
      status: "deployed",
      sessionId: null,
    });

    expect(sessionId).toBe("ses-from-other-heal");
  });
});
