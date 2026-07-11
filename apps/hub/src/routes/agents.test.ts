import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { DB } from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

const TEST_API_KEY = "sk-test-key";

// Response.json() is Promise<unknown> under lib ESNext; assertions cast to the
// expected body shape — a wrong shape fails the expect() at runtime.
type ResBody = {
  error: string;
  detail: string;
  launched: boolean;
  created: boolean;
  leakedAgent: boolean;
  phase: string | null;
  instanceId: string;
  data: Record<string, string>[];
};

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
    // launchAgentSession resolves sources through the CL-2760 catalog cache
    // (CL-2804), which reads this TTL from config.
    workflowDeploy: { modelSourceCacheTtlMs: 45_000 },
  }),
}));

// Launch outcome is driven by resolveModelSources: tests set `sourcesImpl` to
// return sources (launch proceeds), an empty array (resolution fails with
// no_requirements), or throw (resolution errors). The launch path resolves a
// definition's requirements against the instance tenant via resolveModelSources
// (CL-2229), so the definition may be ancestor-owned.
// CL-1521: sources are now plaintext (stored plaintext in DB, not encrypted).
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
mock.module("@intx/db", () => ({
  ...intxDbReal,
  resolveModelSources: async () => {
    const sources = await sourcesImpl();
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
}));

import { Hono } from "hono";
import { createAgentProvisioningRouter } from "./agents";
import { memberAgentInstance } from "../db/schema";
import {
  describeLaunchError,
  persistInstanceToolGrants,
  persistInstanceGrantRequirements,
  launchAgentSession,
  relaunchInstanceIfNeeded,
  reconcileDisconnectedSession,
  registerDisconnectReconciler,
  reconcileWedgedSessions,
  registerWedgeSweepReconciler,
} from "../services/agent-provisioning";
import { resetRelaunchBreaker } from "../services/relaunch-breaker";
import { resetWorkflowModelSourceCache } from "../services/workflow-model-source-cache";

// The relaunch breaker is process-global module state (in-flight dedup +
// failure cooldowns keyed by instance id). A failing launch in one test arms a
// cooldown that suppresses a later test's relaunch of the same instance id,
// so the suite must clear it between tests to stay order-independent.
//
// The launch path also memoizes catalog resolution (CL-2804); clear it too so a
// resolution cached under one test's sourcesImpl can't leak into a later test
// that varies sourcesImpl for the same tenant.
beforeEach(() => {
  resetRelaunchBreaker();
  resetWorkflowModelSourceCache();
});

const {
  agentInstance: agentInstanceTable,
  agentSession: agentSessionTable,
  principal: principalTable,
} = intxDbReal.schema;

function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {},
): Request {
  const { method = "GET", body, userId = "user-1" } = opts;
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const mockSessionService: SessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
  endSession: mock(() => Promise.reject(new Error("not implemented"))),
} as unknown as SessionService;

const mockGrantStore: GrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
};

const mockSidecarRouter: SidecarRouter = {
  sendSourcesUpdate: mock(() => Promise.resolve()),
  getRoutableAddresses: mock(() => [] as string[]),
  events: { on: () => () => {} },
} as unknown as SidecarRouter;

function makeSidecarRouter(
  routable: string[] = [],
  overrides: Partial<SidecarRouter> = {},
): SidecarRouter {
  return {
    sendSourcesUpdate: mock(() => Promise.resolve()),
    sendGrantsUpdate: mock(() => Promise.resolve()),
    getRoutableAddresses: mock(() => routable),
    events: { on: () => () => {} },
    ...overrides,
  } as unknown as SidecarRouter;
}

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

function buildApp(
  db: ReturnType<typeof makeMockDb>,
  sessionService: SessionService = mockSessionService,
  userId = "user-1",
  sidecarRouter: SidecarRouter = mockSidecarRouter,
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  parent.route(
    "/",
    createAgentProvisioningRouter(
      db as unknown as DB["db"],
      sessionService,
      mockGrantStore,
      sidecarRouter,
      mockEventCollectors,
    ),
  );
  return parent;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeSelectChain(rows: any[] = []) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const wherePromise = Promise.resolve(rows) as Promise<any[]> & {
    limit?: unknown;
  };
  wherePromise.limit = mock(() => Promise.resolve(rows));
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
  id: "tenant-1",
  domain: "tenant-1.localhost",
  slug: "ws-1",
  name: "Workbench 1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn-1",
  tenantId: "tenant-1",
  kind: "user",
  refId: "user-1",
};

// ─── GET /agents ──────────────────────────────────────────────────

describe("GET /agents", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(makeRequest("http://localhost/agents"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("tenantId");
  });

  it("returns 403 when the caller has no principal in the queried tenant", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-other"),
    );
    expect(res.status).toBe(403);
  });

  it("returns agent list when the caller has a principal in the tenant", async () => {
    const instance = {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: "ins-1@tenant-1.localhost",
      status: "deployed",
      principalId: "prn-agent-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const agentRow = { id: "agt-1", name: "Loop", tenantId: "tenant-1" };

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
          findMany: mock(() => Promise.resolve([{ instanceId: "ins-1" }])),
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
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.agentName).toBe("Loop");
  });

  it("excludes removed instances (endedAt set) from the list query", async () => {
    // Search a drizzle SQL condition for a column with the given name. Only
    // descends through queryChunks/arrays — never into a Column's `.table`
    // back-reference, which would otherwise surface every column in the schema.
    // biome-ignore lint/suspicious/noExplicitAny: introspecting drizzle SQL chunks
    function referencesColumn(
      node: any,
      columnName: string,
      seen = new Set(),
    ): boolean {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) =>
        referencesColumn(child, columnName, seen),
      );
    }

    const db = makeMockDb({
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        agent: { findMany: mock(() => Promise.resolve([])) },
        agentInstance: { findMany: mock(() => Promise.resolve([])) },
        // A membership is required for the route to reach the agentInstance
        // query whose where-clause this test inspects.
        memberAgentInstance: {
          findMany: mock(() => Promise.resolve([{ instanceId: "ins-1" }])),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);

    const findManyArgs = db.query.agentInstance.findMany.mock.calls[0][0];
    expect(referencesColumn(findManyArgs.where, "ended_at")).toBe(true);
  });
});

// ─── POST /instances/:instanceId/sessions ────────────────────────

describe("POST /instances/:instanceId/sessions", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "deployed",
    principalId: "prn-agent-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const AGENT_ROW = {
    id: "agt-1",
    name: "Loop",
    tenantId: "tenant-1",
    systemPrompt: "You are Loop.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };

  it("returns 404 when instance not found", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) when caller has no principal in the instance tenant, to avoid leaking instance existence", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with launched:true and sessionId on successful session start", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody & { sessionId?: string | null };
    expect(json.launched).toBe(true);
    // Client scopes Action Requests to this session (CL-3286).
    expect(typeof json.sessionId).toBe("string");
    expect(json.sessionId!.length).toBeGreaterThan(0);
  });

  // CL-3152: the "one launch per instance" invariant lives at the
  // launchAgentSession boundary (the shared launch coalescer), so two POSTs
  // racing for the same instance must collapse onto a single launch — no
  // losing attempt whose failure teardown could delete the row mid-ack of the
  // winner (503 phase=provision). launchSession is the single sidecar call
  // launchAgentSession makes, so one invocation proves one launchAgentSession.
  it("coalesces two concurrent POSTs for one instance onto a single launch", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // Hold the launch open so the second POST arrives while the first is still
    // in flight — the window the coalescer must close.
    let releaseLaunch: () => void = () => {};
    const launchSession = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve;
        }),
    );
    const sessionService = { ...mockSessionService, launchSession };

    const app = buildApp(db, sessionService);
    const fire = () =>
      app.fetch(
        makeRequest("http://localhost/instances/ins-1/sessions", {
          method: "POST",
        }),
      );
    const first = fire();
    const second = fire();

    // Wait until a request has reached launchSession (both are in flight by
    // then), then release it so the coalesced launch settles.
    while (launchSession.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseLaunch();

    const [resA, resB] = await Promise.all([first, second]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(((await resA.json()) as ResBody).launched).toBe(true);
    expect(((await resB.json()) as ResBody).launched).toBe(true);
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with launched:true when the instance is already running (relaunches to recover after sidecar reconnect)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "running" }),
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
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.launched).toBe(true);
    expect(sessionService.launchSession).toHaveBeenCalled();
  });

  // CL-2793: this route is now the SOLE wake path for a reaper-slept Myra (the
  // eager /v1/me relaunch was removed). The idle reaper leaves an exact output
  // state — the `agent_session` marked `ended`, the `agent_instance` left
  // `running` (relaunchable), and the address undeployed (NOT routable). Assert
  // that state drives a genuine cold relaunch: because the address is not
  // routable the route skips the idempotent live-refresh branch and calls
  // launchSession, and because the pointed-at session is `ended` a FRESH session
  // is minted rather than the dead one resumed.
  it("wakes a reaper-slept instance (session ended + instance running + unroutable) via a cold relaunch", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "running", sessionId: "ses-old" }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    // The reaper ended this session; the instance still points at it.
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-old", status: "ended" }),
    );

    const insertedSessionIds: string[] = [];
    db.insert = mock((table: unknown) => ({
      values: mock((row: { id?: string }) => {
        if (table === agentSessionTable && typeof row.id === "string") {
          insertedSessionIds.push(row.id);
        }
        return { returning: mock(() => Promise.resolve([])) };
      }),
    }));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    // Not routable — mirrors the reaper's undeployed output.
    const sidecarRouter = makeSidecarRouter([]);
    const app = buildApp(db, sessionService, "user-1", sidecarRouter);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.launched).toBe(true);
    // The wake contract: a cold, unroutable instance is relaunched.
    expect(sessionService.launchSession).toHaveBeenCalled();
    // A fresh session was minted (the ended one was not resumed).
    expect(insertedSessionIds.length).toBe(1);
    expect(insertedSessionIds[0]).not.toBe("ses-old");
  });

  // CL-2793: on a cold wake nothing is pushed live beforehand — the sidecar is
  // not connected for this address — so the DEFINITION's tool grants must ride
  // the launch config (`config.grants`), not a live sendGrantsUpdate push. This
  // guards the "skip live push when cold" contract: the grants collected for the
  // instance principal (persisted from the definition's capabilities) reach the
  // sidecar through launchSession, and no out-of-band grant push is attempted.
  it("carries the collected definition tool grants in the cold launch config without a live grants push", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "deployed" }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        ...AGENT_ROW,
        capabilities: { tools: ["granola:granola_list_notes"] },
      }),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // collectGrants is the @intx boundary: it returns the grants persisted for
    // the instance principal from the definition's capabilities. A non-empty set
    // here stands in for a real definition's tool grants (default tests use []).
    const definitionGrants = [
      {
        id: "grant-1",
        resource: "tool:granola:granola_list_notes",
        action: "invoke",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: "prn-agent-1",
      },
    ];
    const originalCollect = mockGrantStore.collectGrants;
    mockGrantStore.collectGrants = mock(() =>
      Promise.resolve(definitionGrants),
    ) as GrantStore["collectGrants"];

    let capturedConfig: { config?: { grants?: unknown } } | undefined;
    const sessionService = {
      ...mockSessionService,
      launchSession: mock((cfg: { config?: { grants?: unknown } }) => {
        capturedConfig = cfg;
        return Promise.resolve();
      }),
    };
    const sendGrantsUpdate = mock(() => Promise.resolve());
    const sidecarRouter = makeSidecarRouter([], { sendGrantsUpdate });

    try {
      const app = buildApp(db, sessionService, "user-1", sidecarRouter);
      const res = await app.fetch(
        makeRequest("http://localhost/instances/ins-1/sessions", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(200);
      // The definition's grants reached the sidecar via the launch config.
      expect(capturedConfig?.config?.grants).toEqual(definitionGrants);
      // No out-of-band live push on the cold path (grants ride the launch).
      expect(sendGrantsUpdate).not.toHaveBeenCalled();
    } finally {
      mockGrantStore.collectGrants = originalCollect;
    }
  });

  it("returns 200 with launched:true when launchSession fails because the agent already exists on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // In production, the sidecar returns "Agent already exists" wrapped in a
    // provision-phase SessionLaunchError. Simulate that here.
    const provisionError = new SessionLaunchError(
      "provision",
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false,
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(provisionError)),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.launched).toBe(true);
    expect("launchError" in json).toBe(false);
    // Provision-phase failures must not be retried — one attempt only.
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it("returns 503 with error when source resolution yields nothing", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    // No resolvable inference sources — launch fails and the endpoint surfaces 503.
    sourcesImpl = () => Promise.resolve([]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as ResBody;
    expect(json.error).toBe("Failed to launch agent session");
    expect(json.detail).toContain("No resolvable inference sources");
    expect(json.phase).toBeNull();
  });

  it("surfaces the SessionLaunchError phase and the failing-package detail in the 503 body", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const launchError = new SessionLaunchError(
      "pack",
      new Error(
        "tool-package @workbench/tools-granola@1.2.3 failed validation",
      ),
      false,
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(launchError)),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as ResBody;
    expect(json.error).toBe("Failed to launch agent session");
    expect(json.phase).toBe("pack");
    expect(json.detail).toContain("@workbench/tools-granola@1.2.3");
  });
});

describe("describeLaunchError", () => {
  it("extracts phase and the cause message from a SessionLaunchError", () => {
    const err = new SessionLaunchError(
      "provision",
      new Error("tool-package @workbench/tools-exa@2.0.0 failed validation"),
      false,
    );
    expect(describeLaunchError(err)).toEqual({
      phase: "provision",
      detail: "tool-package @workbench/tools-exa@2.0.0 failed validation",
      leakedAgent: false,
    });
  });

  it("reports a plain Error with a null phase", () => {
    expect(describeLaunchError(new Error("boom"))).toEqual({
      phase: null,
      detail: "boom",
      leakedAgent: false,
    });
  });

  it("stringifies a non-Error value", () => {
    expect(describeLaunchError("nope")).toEqual({
      phase: null,
      detail: "nope",
      leakedAgent: false,
    });
  });

  it("extracts leakedAgent=true from a SessionLaunchError whose sidecar undeploy also failed", () => {
    const err = new SessionLaunchError("start", new Error("kernel died"), true);
    expect(describeLaunchError(err)).toEqual({
      phase: "start",
      detail: "kernel died",
      leakedAgent: true,
    });
  });
});

describe("relaunchInstanceIfNeeded", () => {
  const TENANT_ROW = { id: "tenant-1", domain: "tenant-1.localhost" };
  const AGENT_ROW = {
    id: "agt-1",
    systemPrompt: "You are Myra.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };
  const ACTIVE_CREDENTIAL = {
    id: "crd-1",
    tenantId: "tenant-1",
    status: "active",
  };

  function runningInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: "ins-1@tenant-1.localhost",
      status: "running",
      sessionId: "ses-1",
      principalId: "prn-agent-1",
      ...overrides,
    };
  }

  it('handles "agent already exists" gracefully when instance is running on sidecar', async () => {
    // After a sidecar restart the DB may still show "running" while the sidecar has the agent
    // alive. launchSession throws "Agent already exists for address"; relaunchInstanceIfNeeded
    // must treat that as success rather than surfacing an error.
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      // The sidecar wraps the "already exists" error in a provision-phase SessionLaunchError,
      // which breaks the retry loop and propagates to our isAgentAlreadyExistsError check.
      launchSession: mock(() =>
        Promise.reject(
          new SessionLaunchError(
            "provision",
            new Error(
              "Agent already exists for address ins-1@tenant-1.localhost",
            ),
            false,
          ),
        ),
      ),
    };
    // Must not throw — the agent is live, so this is a no-op.
    await expect(
      relaunchInstanceIfNeeded(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        "ins-1",
        makeSidecarRouter() as never,
      ),
    ).resolves.toBeUndefined();

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch a deployed instance that still has an active session (harness owns continuity) (CL-1651)", async () => {
    const db = makeMockDb();
    // Interchange continuity model: a launched agent's harness persists its state
    // and resumes it on reconnect (ARCHITECTURE.md "Agent Continuity"). A "deployed"
    // status with an active session means the harness is mid-reconnect, not gone —
    // the hub must not relaunch it.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed" })),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it("passes plaintext apiKey sources directly to launchSession (CL-1521: no decryption)", async () => {
    const db = makeMockDb();
    // Cold start: no active session, so the hub launches and we can inspect sources.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed", sessionId: null })),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg = (sessionService.launchSession as ReturnType<typeof mock>)
      .mock.calls[0]![0] as {
      config: { sources: { apiKey: string }[] };
    };
    expect(launchArg.config.sources[0]?.apiKey).toBe(TEST_API_KEY);
  });

  it("does not relaunch a non-running instance when the catalog cannot resolve its model", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed" })),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    // Catalog resolution yields no sources (no_requirements) — the guard skips relaunch.
    sourcesImpl = () => Promise.resolve([]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });
});

// ─── persistInstanceToolGrants ────────────────────────────────────

describe("persistInstanceToolGrants", () => {
  it("inserts grant rows with correct shape for each tool name", async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    const now = new Date("2026-01-01T00:00:00Z");
    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search", "dispatch"],
      now,
    });

    const rows = insertedRows as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenantId).toBe("tenant-1");
      expect(row.principalId).toBe("prn-1");
      expect(row.action).toBe("invoke");
      expect(row.effect).toBe("allow");
      expect(row.origin).toBe("system");
      expect(typeof row.resource).toBe("string");
      expect((row.resource as string).startsWith("tool:")).toBe(true);
      expect(row.roleId).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.createdAt).toEqual(now);
      expect(row.updatedAt).toEqual(now);
    }
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain("tool:exa_search");
    expect(resources).toContain("tool:dispatch");
  });

  it("de-duplicates tool names — duplicate entries produce one row per unique name", async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search", "exa_search", "dispatch"],
      now: new Date(),
    });

    const rows = insertedRows as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain("tool:exa_search");
    expect(resources).toContain("tool:dispatch");
  });

  it("deletes existing system grants before inserting new ones", async () => {
    const ops: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({
        delete: mock(() => {
          ops.push("delete");
          return { where: mock(() => Promise.resolve()) };
        }),
        insert: mock(() => {
          ops.push("insert");
          return { values: mock(() => Promise.resolve()) };
        }),
      }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search"],
      now: new Date(),
    });

    expect(ops[0]).toBe("delete");
    expect(ops[1]).toBe("insert");
  });

  it("skips insert but still deletes when toolNames is empty", async () => {
    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: [],
      now: new Date(),
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ─── GET /agents (additional branches) ───────────────────────────

describe("GET /agents — personal-agent exclusion", () => {
  it("filters out the caller personal-agent instance from the shared list", async () => {
    const sharedInstance = {
      id: "ins-oat",
      agentId: "agt-oat",
      tenantId: "tenant-1",
      address: "ins-oat@tenant-1.localhost",
      status: "deployed",
      principalId: "prn-agent-oat",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    // The personal exclusion is pushed into the membership query
    // (notInArray(templateKey, personalKeys)), so its result already omits the
    // myra mapping; the instance query is then scoped to the remaining ids.
    db.query.memberAgentInstance.findMany = mock(() =>
      Promise.resolve([{ instanceId: "ins-oat", templateKey: "oat" }]),
    );
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([sharedInstance]),
    );
    db.query.agent.findMany = mock(() =>
      Promise.resolve([{ id: "agt-oat", name: "Oat", tenantId: "tenant-1" }]),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.id).toBe("ins-oat");
    expect(json.data[0]?.agentName).toBe("Oat");
  });
});

// ─── DELETE /tenants/:tenantId/agents/instances/:instanceId ───────

describe("DELETE /tenants/:tenantId/agents/instances/:instanceId", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "running",
    principalId: "prn-agent-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the instance does not exist", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("stops the instance, removes the mapping, ends the sidecar session, and returns 204", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const setWhere = mock(() => Promise.resolve());
    const setMock = mock(() => ({ where: setWhere }));
    db.update = mock(() => ({ set: setMock }));
    const deleteWhere = mock(() => Promise.resolve());
    db.delete = mock(() => ({ where: deleteWhere }));

    const endSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, endSession };

    const app = buildApp(db, sessionService as unknown as SessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(setMock).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledWith(
      INSTANCE.address,
      "user deleted instance",
    );
  });

  it("still returns 204 when ending the sidecar session rejects", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const sessionService = {
      ...mockSessionService,
      endSession: mock(() => Promise.reject(new Error("sidecar down"))),
    };
    const app = buildApp(db, sessionService as unknown as SessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("soft-deletes by default: stops the instance but never deletes the agent_instance row", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    db.update = mock(() => ({ set: setMock }));
    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(setMock).toHaveBeenCalled();
    expect(deletedTables).toContain(memberAgentInstance);
    expect(deletedTables).not.toContain(agentInstanceTable);
  });

  it("hard-deletes an ephemeral workflow instance (ins_ses_ prefix) when hard=true", async () => {
    const ephemeral = { ...INSTANCE, id: "ins_ses_abc-tenant-1" };
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(ephemeral));

    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const endSession = mock(() => Promise.resolve());
    const app = buildApp(db, {
      ...mockSessionService,
      endSession,
    } as unknown as SessionService);
    const res = await app.fetch(
      makeRequest(
        "http://localhost/tenants/tenant-1/agents/instances/ins_ses_abc-tenant-1?hard=true",
        { method: "DELETE" },
      ),
    );
    expect(res.status).toBe(204);
    expect(deletedTables).toContain(memberAgentInstance);
    expect(deletedTables).toContain(agentInstanceTable);
    expect(endSession).toHaveBeenCalledWith(
      ephemeral.address,
      "user deleted instance",
    );
  });

  it("refuses hard delete for a non-ephemeral instance (protects chat history)", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest(
        "http://localhost/tenants/tenant-1/agents/instances/ins-1?hard=true",
        {
          method: "DELETE",
        },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ResBody).error).toContain("ephemeral");
    expect(deletedTables).not.toContain(agentInstanceTable);
  });
});

// ─── POST /instances/:instanceId/sessions (additional branches) ───

describe("POST /instances/:instanceId/sessions — branches", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "deployed",
    principalId: "prn-agent-1",
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const AGENT_ROW = {
    id: "agt-1",
    name: "Loop",
    tenantId: "tenant-1",
    systemPrompt: "You are Loop.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };

  it("returns launched:true immediately when the agent is already routable on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const app = buildApp(
      db,
      sessionService as unknown as SessionService,
      "user-1",
      makeSidecarRouter([INSTANCE.address]),
    );
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ResBody).launched).toBe(true);
    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it("refreshes grants and pushes sendGrantsUpdate when the agent is already routable", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        ...AGENT_ROW,
        capabilities: {
          tools: ["@workbench/tools-granola/granola:granola_list_notes"],
        },
      }),
    );

    const sendGrantsUpdate = mock(() => Promise.resolve());
    const router = makeSidecarRouter([INSTANCE.address], {
      sendGrantsUpdate,
    } as Partial<SidecarRouter>);

    const app = buildApp(db, mockSessionService, "user-1", router);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ResBody).launched).toBe(true);
    expect(sendGrantsUpdate).toHaveBeenCalledWith(
      INSTANCE.address,
      expect.any(Array),
    );
  });

  it("returns 409 when the instance was explicitly deleted (stopped with endedAt)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "stopped", endedAt: new Date() }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ResBody).error).toContain("deleted");
  });

  it("resets a stopped (not deleted) instance to deployed before launching", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "stopped", endedAt: null }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const setWhere = mock(() => Promise.resolve());
    const setMock = mock((_set: { status?: string }) => ({ where: setWhere }));
    db.update = mock(() => ({ set: setMock }));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const resetCall = setMock.mock.calls.find(
      (c) => c[0].status === "deployed",
    );
    expect(resetCall).toBeTruthy();
  });

  it("returns 500 when the tenant has no domain configured", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as ResBody).error).toContain(
      "Tenant configuration",
    );
  });

  it("returns 500 when the agent has no system prompt", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        name: "Loop",
        tenantId: "tenant-1",
        systemPrompt: null,
      }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as ResBody).error).toContain(
      "Agent configuration",
    );
  });
});

// ─── GET /agents/templates ────────────────────────────────────────

describe("GET /agents/templates", () => {
  it("returns deployable, non-personal templates with key/name/description/tools", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/agents/templates"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    const keys = json.data.map((t) => t.key);
    expect(keys).toContain("oat");
    // Personal (myra) and non-deployable (loop) templates are excluded.
    expect(keys).not.toContain("myra");
    expect(keys).not.toContain("loop");
    for (const t of json.data) {
      expect(Object.keys(t).sort()).toEqual([
        "description",
        "key",
        "name",
        "tools",
      ]);
      expect(Array.isArray(t.tools)).toBe(true);
    }
  });
});

// ─── POST /tenants/:tenantId/agents/instances (deploy) ────────────

describe("POST /tenants/:tenantId/agents/instances", () => {
  const DEF = {
    id: "agt-def-oat",
    name: "Oat",
    tenantId: "org-tenant",
    systemPrompt: "You are Oat.",
    capabilities: { tools: [] },
    grantRequirements: [],
    modelRequirements: null,
    toolPackages: null,
  };

  function deployDb() {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(DEF));
    return db;
  }

  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when templateKey is missing", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: {},
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ResBody).error).toContain("templateKey");
  });

  it("returns 400 for an unknown template key", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "does-not-exist" },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ResBody).error).toContain("non-deployable");
  });

  it("returns 400 for a non-deployable template (loop)", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "loop" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when the tenant has no domain configured", async () => {
    const db = deployDb();
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as ResBody).error).toContain(
      "Tenant configuration",
    );
  });

  it("returns 404 when no agent definition is found in the tenant hierarchy", async () => {
    const db = deployDb();
    db.query.agent.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ResBody).error).toContain("not found");
  });

  it("creates the instance, launches the session, and returns 201", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const inserted: Record<string, unknown>[] = [];
    const insertMock = mock(() => ({
      values: mock((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      }),
    }));
    db.insert = insertMock;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: insertMock,
        update: db.update,
        delete: db.delete,
      }),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as ResBody;
    expect(json.created).toBe(true);
    expect(typeof json.instanceId).toBe("string");
    // principal + agentInstance + memberAgentInstance inserted in the transaction.
    expect(inserted.length).toBeGreaterThanOrEqual(3);
  });

  it("grants the caller read/write/manage on the new instance", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const inserted: Record<string, unknown>[] = [];
    const insertMock = mock(() => ({
      values: mock((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      }),
    }));
    db.insert = insertMock;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: insertMock, update: db.update, delete: db.delete }),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
    const instanceId = ((await res.json()) as ResBody).instanceId;
    const memberGrants = inserted.filter(
      (row) =>
        row.resource === `instance:${instanceId}` &&
        row.principalId === PRINCIPAL.id &&
        row.effect === "allow",
    );
    expect(memberGrants.map((g) => g.action).sort()).toEqual([
      "manage",
      "read",
      "write",
    ]);
  });

  it("returns 503 with phase + detail and rolls back the instance when the post-create launch fails", async () => {
    const db = deployDb();
    // No sources -> launchAgentSession throws -> rolled back and surfaced as 503.
    sourcesImpl = () => Promise.resolve([]);

    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    const deletedTables: unknown[] = [];
    const deleteMock = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });
    db.insert = insertMock as never;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: insertMock, update: db.update, delete: deleteMock }),
    ) as never;

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as ResBody;
    expect(json.error).toBe("Failed to launch agent session");
    expect(json.detail).toContain("No resolvable inference sources");
    expect(json.phase).toBeNull();
    // The teardown deletes the instance, then the lingering agent_session
    // (FK→principal, RESTRICT), then the principal — in that order, so the
    // principal delete cannot FK-violate and abort the rollback. The
    // agent_session delete is the load-bearing one: without it a real DB would
    // 500 and leave the orphan this rollback exists to remove.
    const instanceIdx = deletedTables.indexOf(agentInstanceTable);
    const sessionIdx = deletedTables.indexOf(agentSessionTable);
    const principalIdx = deletedTables.indexOf(principalTable);
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(instanceIdx).toBeLessThan(sessionIdx);
    expect(sessionIdx).toBeLessThan(principalIdx);
  });

  it("does NOT roll back and marks the instance error when the launch leaked an agent (CL-2367)", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // The sidecar provisioned the agent but its own undeploy ALSO failed, so a
    // zombie agent survives on the sidecar. Tearing down the hub rows would
    // orphan it (next mail 502s until a sidecar restart).
    const leakedError = new SessionLaunchError(
      "start",
      new Error("session start failed; sidecar undeploy also failed"),
      true,
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(leakedError)),
    };

    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    const deletedTables: unknown[] = [];
    const deleteMock = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });
    const updates: Record<string, unknown>[] = [];
    const updateMock = mock((table: unknown) => ({
      set: mock((values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { where: mock(() => Promise.resolve()) };
      }),
    }));
    db.insert = insertMock as never;
    db.update = updateMock as never;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: insertMock, update: updateMock, delete: deleteMock }),
    ) as never;

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as ResBody;
    expect(json.error).toBe("Failed to launch agent session");
    expect(json.leakedAgent).toBe(true);
    // No teardown ran — the leaked sidecar agent must keep its hub rows. (The
    // grant-requirement materialization deletes/re-inserts grant rows before
    // launch, so we assert the teardown-owned rows specifically, not a total of
    // zero deletes.)
    expect(deletedTables).not.toContain(agentInstanceTable);
    expect(deletedTables).not.toContain(agentSessionTable);
    expect(deletedTables).not.toContain(principalTable);
    // The instance was marked 'error' so a later relaunch can adopt it.
    const errorUpdate = updates.find(
      (u) =>
        u.table === agentInstanceTable &&
        (u.values as { status?: string }).status === "error",
    );
    expect(errorUpdate).toBeDefined();
  });

  it("keeps the instance and returns 201 when launch reports the agent already exists", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // Reconnect race: the orchestrator already provisioned the agent, so the
    // sidecar reports "Agent already exists" (wrapped in a provision-phase
    // SessionLaunchError). The agent is live — the deploy must NOT tear it down.
    const provisionError = new SessionLaunchError(
      "provision",
      new Error('Agent already exists for address "ins-1@tenant-1.localhost"'),
      false,
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(provisionError)),
    };

    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.insert = insertMock as never;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: insertMock, update: db.update, delete: db.delete }),
    ) as never;

    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    // Launch was attempted, hit the already-exists race, and the route kept the
    // live instance instead of tearing it down + 503 (the failure branch returns
    // 503, so a 201 proves no teardown ran).
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    expect(((await res.json()) as ResBody).created).toBe(true);
  });

  it("walks up the tenant hierarchy to find the definition in a parent tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // tenant-1 has parent org-tenant. tenant lookups: first the route fetch
    // (tenant-1), then hierarchy walk over org-tenant.
    db.query.tenant.findFirst = mock((args: { where?: unknown }) => {
      void args;
      return Promise.resolve({
        id: "tenant-1",
        domain: "tenant-1.localhost",
        parentId: "org-tenant",
      });
    });
    // Definition only exists under the parent: first agent.findFirst (cursor=org-tenant) hits.
    db.query.agent.findFirst = mock(() => Promise.resolve(DEF));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ─── launchAgentSession (direct) ──────────────────────────────────

describe("launchAgentSession", () => {
  const BASE_OPTS = {
    agentId: "agt-1",
    instanceId: "ins-1",
    instancePrincipalId: "prn-agent-1",
    tenantId: "tenant-1",
    tenantDomain: "tenant-1.localhost",
    systemPrompt: "You are an agent.",
    now: new Date("2026-01-01T00:00:00Z"),
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

  it("throws when there are no resolvable inference sources", async () => {
    sourcesImpl = () => Promise.resolve([]);
    await expect(
      launchAgentSession(
        launchDb() as never,
        mockSessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("No resolvable inference sources");
  });

  it("throws when the agent row is missing", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agent.findFirst = mock(() => Promise.resolve(undefined));
    await expect(
      launchAgentSession(
        db as never,
        mockSessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("Agent not found");
  });

  it("launches successfully, registers the event collector, and returns address/sessionId", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const createCollector = mock(() => {});
    const eventCollectors = { ...mockEventCollectors, create: createCollector };
    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      eventCollectors as never,
      BASE_OPTS,
    );
    expect(result.address).toBe("ins-1@tenant-1.localhost");
    expect(typeof result.sessionId).toBe("string");
    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(createCollector).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a provision-phase SessionLaunchError and rethrows", async () => {
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

  it("retries after a transient (non-provision) launch failure and then succeeds", async () => {
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

  it("reuses the instance existing active session instead of minting a new one (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-existing" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-existing", status: "active" }),
    );
    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.insert = insertMock;
    let launchedSessionId: string | undefined;
    const launchSession = mock((cfg: { config: { sessionId: string } }) => {
      launchedSessionId = cfg.config.sessionId;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    expect(result.sessionId).toBe("ses-existing");
    expect(launchedSessionId).toBe("ses-existing");
  });

  it("mints a new session when the instance session is not active (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-ended" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ended", status: "ended" }),
    );
    let launchedSessionId: string | undefined;
    const launchSession = mock((cfg: { config: { sessionId: string } }) => {
      launchedSessionId = cfg.config.sessionId;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    expect(result.sessionId).not.toBe("ses-ended");
    expect(result.sessionId.startsWith("ses_")).toBe(true);
    expect(launchedSessionId).toBe(result.sessionId);
  });

  it("stamps endedAt when ending the session after a terminal launch failure (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    const setMock = mock((_set: { status?: string; endedAt?: Date }) => ({
      where: mock(() => Promise.resolve()),
    }));
    db.update = mock(() => ({ set: setMock }));
    const provisionError = new SessionLaunchError(
      "provision",
      new Error("rejected"),
      false,
    );
    const launchSession = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);

    const endedCall = setMock.mock.calls.find((c) => c[0].status === "ended");
    expect(endedCall).toBeTruthy();
    expect(endedCall?.[0].endedAt).toBeInstanceOf(Date);
  });
});

// ─── persistInstanceGrantRequirements ─────────────────────────────

describe("persistInstanceGrantRequirements", () => {
  function captureTx() {
    const insertedRows: Record<string, unknown>[] = [];
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    const insertMock = mock(() => ({
      values: mock((rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
        return Promise.resolve();
      }),
    }));
    const txMock = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ delete: deleteMock, insert: insertMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];
    return { db, insertedRows, deleteMock, insertMock };
  }

  it("materializes declared requirements plus the dynamic per-tenant deliver grant", async () => {
    const { db, insertedRows, deleteMock } = captureTx();
    const now = new Date("2026-01-01T00:00:00Z");
    await persistInstanceGrantRequirements(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      grantRequirements: [
        { source: "creator", resource: "tool:mail_send", action: "invoke" },
        {
          source: "invoker",
          resource: "doc:x",
          action: "read",
          effect: "deny",
        },
      ],
      now,
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    // 2 declared + 1 dynamic deliver grant.
    expect(insertedRows).toHaveLength(3);

    const creatorRow = insertedRows.find(
      (r) => r.resource === "tool:mail_send",
    );
    expect(creatorRow?.origin).toBe("creator");
    expect(creatorRow?.effect).toBe("allow");

    const invokerRow = insertedRows.find((r) => r.resource === "doc:x");
    expect(invokerRow?.origin).toBe("invoker");
    expect(invokerRow?.effect).toBe("deny");

    const deliver = insertedRows.find((r) => r.action === "deliver");
    expect(deliver?.resource).toBe("tenant:tenant-1");
    expect(deliver?.origin).toBe("invoker");
    expect(deliver?.createdAt).toEqual(now);
  });

  it("always inserts at least the deliver grant when no requirements are declared", async () => {
    const { db, insertedRows } = captureTx();
    await persistInstanceGrantRequirements(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      grantRequirements: [],
      now: new Date(),
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.action).toBe("deliver");
  });
});

// ─── relaunchInstanceIfNeeded (additional branches) ───────────────

describe("relaunchInstanceIfNeeded — early returns", () => {
  it("no-ops when the instance does not exist", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance was explicitly deleted (stopped with endedAt)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "stopped",
        endedAt: new Date(),
        address: "ins-1@tenant-1.localhost",
      }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the agent is already routable on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "running",
        endedAt: null,
        address: "ins-1@tenant-1.localhost",
      }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter(["ins-1@tenant-1.localhost"]) as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance already has an active session (sidecar owns it) (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-1",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance session is ending (mid-teardown) (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-ending",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ending", status: "ending" }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("relaunches when the instance session is no longer active (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        principalId: "prn-agent-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-ended",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ended", status: "ended" }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        systemPrompt: "You are an agent.",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: [],
        modelRequirements: null,
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the tenant has no domain", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        address: "ins-1@tenant-1.localhost",
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the agent has no system prompt", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({ id: "agt-1", systemPrompt: null }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('rethrows a non-"already exists" launch error', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        principalId: "prn-agent-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: null,
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        systemPrompt: "You are Loop.",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: [],
        modelRequirements: null,
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const launchSession = mock(() =>
      Promise.reject(
        new SessionLaunchError("provision", new Error("boom"), false),
      ),
    );

    await expect(
      relaunchInstanceIfNeeded(
        db as never,
        { ...mockSessionService, launchSession } as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        "ins-1",
        makeSidecarRouter() as never,
      ),
    ).rejects.toThrow("boom");
  });
});

// ─── reconcileDisconnectedSession ─────────────────────────────────
//
// When a sidecar fully restarts (every redeploy) it connects fresh with no
// agents, so the address it previously routed never reconnects. Interchange's
// orchestrator only abandons the event collector on sidecar.disconnect; it
// leaves agent_session.status = 'active' so a transient reconnect can resume.
// Nothing reconciles the DB when the reconnect never comes, leaving Myra wedged
// (active session, unroutable address) — relaunchInstanceIfNeeded then returns
// early forever. This reconcile is the host-side cleanup that retires the
// manual reset-myra ritual. (CL-1692)

function makeUpdateCapture() {
  const calls: Record<string, unknown>[] = [];
  const update = mock(() => ({
    set: mock((values: Record<string, unknown>) => {
      calls.push(values);
      return { where: mock(() => Promise.resolve()) };
    }),
  }));
  return { update, calls };
}

describe("reconcileDisconnectedSession", () => {
  const ADDR = "ins-1@tenant-1.localhost";

  it("no-ops when no instance is found for the address", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the address became routable again (sidecar reconnected)", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter([ADDR]) as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the instance has no session", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: null }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the session is already ended", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "ended" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("marks an active session ended when the address never reconnected", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("marks an ending session ended (a dead sidecar never completes teardown)", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "ending" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
  });
});

describe("registerDisconnectReconciler", () => {
  const ADDR = "ins-1@tenant-1.localhost";

  function makeEventRouter(routable: string[] = []) {
    let disconnectListener:
      | ((p: { agentAddresses: string[] }) => void)
      | undefined;
    const router = {
      getRoutableAddresses: mock(() => routable),
      events: {
        on: mock(
          (
            type: string,
            listener: (p: { agentAddresses: string[] }) => void,
          ) => {
            if (type === "sidecar.disconnect") disconnectListener = listener;
            return () => {};
          },
        ),
      },
    } as unknown as SidecarRouter;
    return {
      router,
      fire: (addrs: string[]) =>
        disconnectListener?.({ agentAddresses: addrs }),
    };
  }

  it("subscribes to sidecar.disconnect and reconciles after the grace window", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const { router, fire } = makeEventRouter([]);

    registerDisconnectReconciler({ db: db as never, router, graceMs: 1 });
    fire([ADDR]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
  });

  it("does not reconcile when the address reconnected within the grace window", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const { router, fire } = makeEventRouter([ADDR]);

    registerDisconnectReconciler({ db: db as never, router, graceMs: 1 });
    fire([ADDR]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(calls).toHaveLength(0);
  });
});

// ─── reconcileWedgedSessions (periodic sweep) ─────────────────────
//
// The sweep supplies the RELAUNCH half missing from the disconnect reconciler:
// an instance left active-but-unroutable after a sidecar restart is ended and
// relaunched so its address re-registers. It measures *sustained* unroutability
// against a caller-owned tracker (never session age, which never moves for a
// live session), so a normal redeploy reconnect that lands within the grace is
// never evicted. These assert that dangerous path across the hub↔router seam
// (getRoutableAddresses): grace gating, tracker clearing on reconnect, selection
// on relaunchable status (not age), the right-before-relaunch guard, and
// end-before-relaunch ordering.

describe("reconcileWedgedSessions", () => {
  const ADDR = "ins-1@tenant-1.localhost";
  const TENANT_ROW = { id: "tenant-1", domain: "tenant-1.localhost" };
  const AGENT_ROW = {
    id: "agt-1",
    systemPrompt: "You are Myra.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };

  function wedgedInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: ADDR,
      status: "running",
      sessionId: "ses-1",
      principalId: "prn-agent-1",
      ...overrides,
    };
  }

  // agentSession status flips to "ended" after the first read, so
  // reconcileDisconnectedSession (first read: active → ends it) and the
  // subsequent relaunch (reads: ended → proceeds as a cold start) compose.
  function flippingSessionFindFirst() {
    let reads = 0;
    return mock(() => {
      reads += 1;
      return Promise.resolve({
        id: "ses-1",
        status: reads === 1 ? "active" : "ended",
      });
    });
  }

  // A db whose sweep selection returns the single wedged instance and whose
  // findFirst lookups feed both reconcile-then-relaunch. `update` is captured so
  // tests can assert the session was ended.
  function makeWedgedDb() {
    const { update, calls } = makeUpdateCapture();
    const db = makeMockDb({
      select: mock(() =>
        makeSelectChain([{ instanceId: "ins-1", address: ADDR }]),
      ),
      update,
    });
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(wedgedInstance()),
    );
    db.query.agentSession.findFirst = flippingSessionFindFirst();
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    return { db, calls };
  }

  it("never acts on the first tick an address is unroutable, and only relaunches once the grace has elapsed across ticks", async () => {
    // THE REGRESSION GUARD: a reconnecting agent is momentarily unroutable.
    // The sweep must give it the full grace window across ticks before evicting.
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const { db, calls } = makeWedgedDb();
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const tracker = new Map<string, number>();
    const grace = 100;

    const tick = (now: number) =>
      reconcileWedgedSessions(
        db as never,
        makeSidecarRouter([]) as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        tracker,
        { graceMs: grace, now },
      );

    // First sighting: record only, never relaunch.
    await tick(0);
    expect(sessionService.launchSession).not.toHaveBeenCalled();
    expect(tracker.get(ADDR)).toBe(0);

    // Still within grace: still no relaunch.
    await tick(grace - 1);
    expect(sessionService.launchSession).not.toHaveBeenCalled();

    // Grace elapsed while continuously unroutable: now it acts.
    await tick(grace);
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.status === "ended")).toBe(true);
    // Tracker entry consumed after acting.
    expect(tracker.has(ADDR)).toBe(false);
  });

  it("clears the tracker and never relaunches when the address reconnects before the grace elapses", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const { db, calls } = makeWedgedDb();
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const tracker = new Map<string, number>();
    const grace = 100;

    // Tick 1 — unroutable, first sighting recorded.
    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([]) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: grace, now: 0 },
    );
    expect(tracker.get(ADDR)).toBe(0);

    // Tick 2 — the sidecar reconnected within the grace: entry is cleared.
    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([ADDR]) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: grace, now: grace - 1 },
    );
    expect(tracker.has(ADDR)).toBe(false);

    // Tick 3 — unroutable again well past the original window, but it counts as
    // a fresh first sighting, so still no relaunch.
    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([]) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: grace, now: grace * 5 },
    );
    expect(tracker.get(ADDR)).toBe(grace * 5);
    expect(sessionService.launchSession).not.toHaveBeenCalled();
    expect(calls.some((c) => c.status === "ended")).toBe(false);
  });

  it("ends the session before relaunching once the grace has elapsed", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const order: string[] = [];

    const db = makeMockDb({
      select: mock(() =>
        makeSelectChain([{ instanceId: "ins-1", address: ADDR }]),
      ),
      update: mock(() => ({
        set: mock((values: Record<string, unknown>) => {
          if (values.status === "ended") order.push("end");
          return { where: mock(() => Promise.resolve()) };
        }),
      })),
    });
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(wedgedInstance()),
    );
    db.query.agentSession.findFirst = flippingSessionFindFirst();
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => {
        order.push("launch");
        return Promise.resolve();
      }),
    };

    // Pre-seed the tracker as already unroutable long enough so this single tick
    // acts.
    const tracker = new Map<string, number>([[ADDR, 0]]);
    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([]) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: 100, now: 1_000 },
    );

    expect(order).toEqual(["end", "launch"]);
  });

  it("skips an already-routable instance and clears its tracker entry", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const { db, calls } = makeWedgedDb();
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    // Entry present from a prior tick; a routable read must evict it.
    const tracker = new Map<string, number>([[ADDR, 0]]);

    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([ADDR]) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: 100, now: 10_000 },
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
    expect(calls.some((c) => c.status === "ended")).toBe(false);
    expect(tracker.has(ADDR)).toBe(false);
  });

  it("does not relaunch when the address becomes routable right before relaunch", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // Unroutable on the sweep's own top-of-tick read (so it proceeds to act),
    // then routable on every subsequent read — modeling a reconnect that lands
    // between selection and relaunch. reconcileDisconnectedSession and
    // relaunchInstanceIfNeeded both re-read getRoutableAddresses and must bail.
    let reads = 0;
    const getRoutableAddresses = mock(() => {
      reads += 1;
      return reads === 1 ? [] : [ADDR];
    });

    const { db, calls } = makeWedgedDb();
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    // Pre-seed past grace so the sweep would otherwise act this tick.
    const tracker = new Map<string, number>([[ADDR, 0]]);

    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([], { getRoutableAddresses }) as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      tracker,
      { graceMs: 100, now: 1_000 },
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
    expect(calls.some((c) => c.status === "ended")).toBe(false);
  });

  it("selects on session status and relaunchable instance status, not on session age", async () => {
    // Search a drizzle SQL condition for a column with the given name. Only
    // descends through queryChunks/arrays — never into a Column's `.table`
    // back-reference, which would surface every column in the schema.
    // biome-ignore lint/suspicious/noExplicitAny: introspecting drizzle SQL chunks
    function referencesColumn(node: any, columnName: string, seen = new Set()) {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) =>
        referencesColumn(child, columnName, seen),
      );
    }

    // Search a drizzle SQL condition for a bound param carrying `value` (either
    // directly, or as a member of an array param for `inArray`).
    // biome-ignore lint/suspicious/noExplicitAny: introspecting drizzle SQL chunks
    function bindsValue(node: any, value: string, seen = new Set()): boolean {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (node.value === value) return true;
      if (Array.isArray(node.value) && node.value.includes(value)) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) => bindsValue(child, value, seen));
    }

    let capturedWhere: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const chain: any = {
      from: mock(() => chain),
      innerJoin: mock(() => chain),
      where: mock((cond: unknown) => {
        capturedWhere = cond;
        return Promise.resolve([]);
      }),
    };
    const db = makeMockDb({ select: mock(() => chain) });

    await reconcileWedgedSessions(
      db as never,
      makeSidecarRouter([]) as never,
      {
        ...mockSessionService,
        launchSession: mock(() => Promise.resolve()),
      } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      new Map<string, number>(),
    );

    // Gates on the session being active …
    expect(referencesColumn(capturedWhere, "status")).toBe(true);
    expect(bindsValue(capturedWhere, "active")).toBe(true);
    // … and on relaunchable instance statuses (excludes error/stopped) …
    expect(bindsValue(capturedWhere, "running")).toBe(true);
    expect(bindsValue(capturedWhere, "deployed")).toBe(true);
    expect(bindsValue(capturedWhere, "updating")).toBe(true);
    expect(bindsValue(capturedWhere, "error")).toBe(false);
    expect(bindsValue(capturedWhere, "stopped")).toBe(false);
    // … and NOT on session age (the discredited stale-floor predicate is gone).
    expect(referencesColumn(capturedWhere, "updated_at")).toBe(false);
  });
});

describe("registerWedgeSweepReconciler", () => {
  it("ticks on the interval and stops after unsubscribe (no leaked interval)", async () => {
    // getRoutableAddresses is the first thing every tick calls, so its call
    // count is a faithful tick counter.
    const getRoutableAddresses = mock(() => [] as string[]);
    const router = makeSidecarRouter([], { getRoutableAddresses });
    const db = makeMockDb({ select: mock(() => makeSelectChain([])) });

    const stop = registerWedgeSweepReconciler({
      db: db as never,
      router: router as never,
      sessionService: mockSessionService as never,
      grantStore: mockGrantStore as never,
      eventCollectors: mockEventCollectors as never,
      intervalMs: 15,
    });

    await new Promise((resolve) => setTimeout(resolve, 55));
    const ticksWhileRunning = getRoutableAddresses.mock.calls.length;
    expect(ticksWhileRunning).toBeGreaterThan(0);

    stop();
    await new Promise((resolve) => setTimeout(resolve, 55));
    // No further ticks after teardown — the interval was cleared, not leaked.
    expect(getRoutableAddresses.mock.calls.length).toBe(ticksWhileRunning);
  });

  it("does not overlap ticks: a slow sweep blocks the next interval firing", async () => {
    // Hold the first sweep open on its DB select; while it is in flight the
    // interval must not start a second sweep (the reentrancy guard). Only one
    // getRoutableAddresses call should be observed until the first sweep frees.
    let releaseSelect: (rows: unknown[]) => void = () => {};
    const selectGate = new Promise<unknown[]>((resolve) => {
      releaseSelect = resolve;
    });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const chain: any = {
      from: mock(() => chain),
      innerJoin: mock(() => chain),
      where: mock(() => selectGate),
    };
    const getRoutableAddresses = mock(() => [] as string[]);
    const router = makeSidecarRouter([], { getRoutableAddresses });
    const db = makeMockDb({ select: mock(() => chain) });

    const stop = registerWedgeSweepReconciler({
      db: db as never,
      router: router as never,
      sessionService: mockSessionService as never,
      grantStore: mockGrantStore as never,
      eventCollectors: mockEventCollectors as never,
      intervalMs: 10,
    });

    // Several intervals elapse while the first sweep is stuck on select.
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(getRoutableAddresses.mock.calls.length).toBe(1);

    releaseSelect([]);
    stop();
  });
});

// ─── POST /admin/templates/:templateKey/reconcile-grants ──────────────────────

describe("POST /admin/templates/:templateKey/reconcile-grants", () => {
  it("returns 404 for an unknown template key", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.request(
      "/admin/templates/not-a-template/reconcile-grants",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not a global-tenant user principal", async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.request("/admin/templates/myra/reconcile-grants", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("reconciles and returns counts for a known template", async () => {
    const db = makeMockDb();
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        capabilities: { tools: [] },
        grantRequirements: [],
      }),
    );
    db.query.memberAgentInstance.findMany = mock(() => Promise.resolve([]));
    const app = buildApp(db);
    const res = await app.request("/admin/templates/myra/reconcile-grants", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      templateKey: "myra",
      reconciled: 0,
      pushed: 0,
      skipped: 0,
    });
  });
});
