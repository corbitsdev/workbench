import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { SessionService } from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

const TEST_API_KEY = "sk-test-key";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
    workflowDeploy: { modelSourceCacheTtlMs: 45_000 },
  }),
}));

mock.module("@intx/db", () => ({
  ...intxDbReal,
  resolveModelSources: async (
    _db: unknown,
    _tenantId: unknown,
    _requirements: unknown,
    _opts?: { invokerPreferences?: Record<string, unknown> },
  ) => ({ ok: true, sources: [{ id: "src-1", apiKey: TEST_API_KEY }] }),
}));

const warnLogs: { msg: string; meta?: Record<string, unknown> }[] = [];
mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: () => {},
    warn: (msg: string, meta?: Record<string, unknown>) =>
      warnLogs.push(meta === undefined ? { msg } : { msg, meta }),
    error: () => {},
    debug: () => {},
  }),
}));

// Static imports are hoisted above the mock.module calls above, so
// agent-provisioning.ts (which statically imports @intx/log at module scope)
// must be pulled in via a dynamic import — otherwise it captures the real
// logger before the mock registers, and the warn-log assertions below always
// see an empty array regardless of what the code actually does.
const { launchAgentSession } = await import("./agent-provisioning");
const { resetWorkflowModelSourceCache } = await import(
  "./workflow-model-source-cache"
);

beforeEach(() => {
  resetWorkflowModelSourceCache();
  warnLogs.length = 0;
});

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

function makeMockDb(opts: {
  bound: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
}): { db: any; deleteCalls: any[]; transactionCalls: number } {
  const deleteCalls: unknown[] = [];
  let transactionCalls = 0;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  let base: any;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const txMock = mock((fn: (tx: any) => Promise<unknown>) => {
    transactionCalls += 1;
    return fn(base);
  });
  base = {
    transaction: txMock,
    query: {
      tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
      agent: {
        findFirst: mock(() =>
          Promise.resolve({
            id: "agt-1",
            contextConfig: null,
            initialState: null,
            modelConfig: null,
            capabilities: { tools: ["exa_search"] },
            credentialRequirements: null,
            modelRequirements: null,
            grantRequirements: [
              {
                source: "invoker",
                resource: "tool:mail_send",
                action: "invoke",
              },
            ],
            toolPackages: [],
          }),
        ),
      },
      agentInstance: {
        findFirst: mock(() =>
          Promise.resolve({ id: "ins-1", sessionId: null }),
        ),
      },
      agentSession: { findFirst: mock(() => Promise.resolve(undefined)) },
      memberAgentInstance: {
        findFirst: mock(() =>
          Promise.resolve(
            opts.bound
              ? {
                  id: "mai-1",
                  tenantId: "tenant-1",
                  memberPrincipalId: "prn-member-1",
                  templateKey: "myra",
                  agentId: "agt-1",
                  instanceId: "ins-1",
                }
              : undefined,
          ),
        ),
      },
    },
    select: mock(() => makeSelectChain([])),
    insert: mock(() => ({ values: mock(() => Promise.resolve()) })),
    update: mock(() => ({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    })),
    delete: mock((table: unknown) => {
      deleteCalls.push(table);
      return { where: mock(() => Promise.resolve()) };
    }),
  };
  return { db: base, deleteCalls, transactionCalls };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal GrantRule fixture
function fakeGrantRule(resource: string): any {
  return {
    id: `grn_${resource}`,
    resource,
    action: "invoke",
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: "prn-agent-1",
  };
}

const BASE_OPTS = {
  agentId: "agt-1",
  instanceId: "ins-1",
  instancePrincipalId: "prn-agent-1",
  tenantId: "tenant-1",
  tenantDomain: "tenant-1.localhost",
  systemPrompt: "You are an agent.",
  now: new Date("2026-01-01T00:00:00Z"),
};

describe("launchAgentSession failure cleanup", () => {
  it("deletes both tool and requirement grants when an unbound instance's launch ultimately fails", async () => {
    const { db, deleteCalls } = makeMockDb({ bound: false });
    const launchSession = mock(() =>
      Promise.reject(new Error("sidecar unavailable")),
    );
    const sessionService = {
      launchSession,
      sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
      endSession: mock(() => Promise.reject(new Error("not implemented"))),
    } as unknown as SessionService;
    const grantStore: GrantStore = {
      collectGrants: mock(() => Promise.resolve([])),
    };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        grantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("sidecar unavailable");

    // Two persist-phase transactions (tool grants, requirement grants) plus one
    // cleanup transaction that deletes both origin sets — a clean rollback to
    // zero, not an asymmetric partial state.
    expect(db.transaction).toHaveBeenCalledTimes(3);
    // Three launch-path deletes (tool-grant persist, requirement-grant
    // persist, session-asset reset) plus TWO cleanup deletes — one per grant
    // origin set. The asymmetric cleanup this guards against issued only one.
    expect(deleteCalls).toHaveLength(5);
  }, 10000);

  it("does not strip a bound instance's just-persisted grants when launch ultimately fails", async () => {
    const { db, deleteCalls } = makeMockDb({ bound: true });
    const launchSession = mock(() =>
      Promise.reject(new Error("sidecar unavailable")),
    );
    const sessionService = {
      launchSession,
      sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
      endSession: mock(() => Promise.reject(new Error("not implemented"))),
    } as unknown as SessionService;
    const grantStore: GrantStore = {
      collectGrants: mock(() => Promise.resolve([])),
    };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        grantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("sidecar unavailable");

    // Only the two persist-phase transactions ran; the cleanup transaction was
    // skipped because the instance is still bound to a member.
    expect(db.transaction).toHaveBeenCalledTimes(2);
    // Only the launch-path deletes ran — no cleanup delete touched the
    // bound instance's grants.
    expect(deleteCalls).toHaveLength(3);
    expect(
      warnLogs.some((l) =>
        l.msg.includes("Launch failed for a bound instance"),
      ),
    ).toBe(true);
  }, 10000);

  it("warns when the persisted grant count is far below the expected floor", async () => {
    const { db } = makeMockDb({ bound: true });
    const launchSession = mock(() => Promise.resolve());
    const sessionService = {
      launchSession,
      sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
      endSession: mock(() => Promise.reject(new Error("not implemented"))),
    } as unknown as SessionService;
    // Definition expects 2 grants (1 tool + 1 requirement); collectGrants
    // returns only 1 — the outlier signature.
    const grantStore: GrantStore = {
      collectGrants: mock(() =>
        Promise.resolve([fakeGrantRule("tool:exa_search")]),
      ),
    };

    await launchAgentSession(
      db as never,
      sessionService as never,
      grantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(
      warnLogs.some((l) =>
        l.msg.includes("Persisted grant count far below expected"),
      ),
    ).toBe(true);
  });

  it("does not warn when the persisted grant count matches the expected floor", async () => {
    const { db } = makeMockDb({ bound: true });
    const launchSession = mock(() => Promise.resolve());
    const sessionService = {
      launchSession,
      sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
      endSession: mock(() => Promise.reject(new Error("not implemented"))),
    } as unknown as SessionService;
    const grantStore: GrantStore = {
      collectGrants: mock(() =>
        Promise.resolve([
          fakeGrantRule("tool:exa_search"),
          fakeGrantRule("tool:mail_send"),
        ]),
      ),
    };

    await launchAgentSession(
      db as never,
      sessionService as never,
      grantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );

    expect(
      warnLogs.some((l) =>
        l.msg.includes("Persisted grant count far below expected"),
      ),
    ).toBe(false);
  });
});
