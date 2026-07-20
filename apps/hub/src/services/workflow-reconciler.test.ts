import { describe, expect, it, mock } from "bun:test";
import { schema as intxSchema } from "@intx/db";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import { workflowRunRecord } from "../db/schema";

// The reconciler writes a run terminal via run-store's setRunStatus (CL-2669).
// Mock that boundary so the failOrphanedRuns tests observe the status write
// against the current test's in-memory rows without threading a drizzle
// `.where(eq(id))` expression the fake DB cannot parse.
let failRowsRef: Map<string, { status: string }> | null = null;
// The hibernate branch CAS-re-reads the record via loadRunRecord immediately
// before sending the teardown; tests steer that re-read through this map.
type CasRow = {
  status: string;
  updatedAt: Date;
  pendingSignal: unknown;
};
let casRowsRef: Map<string, CasRow> | null = null;
// Re-delivery refreshes the pending record's timestamp (backoff between
// re-deliveries); tests observe the refresh through this trace. The refresh
// is conditional on the record still holding the same signalId — tests flip
// `refreshResultRef` to model the projection clearing it mid-pass.
const pendingRefreshes: {
  runId: string;
  signalId: string;
  receivedAt: string;
  redeliveries?: number;
}[] = [];
let refreshResultRef = true;
mock.module("../workflow-executor/run-store", () => ({
  setRunStatus: async (_db: unknown, runId: string, status: string) => {
    const row = failRowsRef?.get(runId);
    if (row) row.status = status;
  },
  loadRunRecord: async (_db: unknown, runId: string) =>
    casRowsRef?.get(runId) ?? null,
  refreshPendingSignalIfCurrent: async (
    _db: unknown,
    runId: string,
    signal: { signalId: string; receivedAt: string; redeliveries?: number },
  ) => {
    pendingRefreshes.push({
      runId,
      signalId: signal.signalId,
      receivedAt: signal.receivedAt,
      redeliveries: signal.redeliveries,
    });
    return refreshResultRef;
  },
}));

const {
  createWorkflowReconciler,
  registerAwaitingSupervisorPrewarm,
  WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
} = await import("./workflow-reconciler");

type Row = {
  deploymentId: string | null;
  kind: string;
  tenantId: string;
  principalId: string;
};

// Per-run records (CL-2582): the reconciler re-establishes a supervisor per
// NON-terminal record, keyed by the record's OWN per-run deploymentId + kind +
// tenant. The mock returns these for the workflowRunRecord query (which the real
// reconciler filters to running/awaiting — so seed only non-terminal rows here).
// `status`/`updatedAt` feed the hibernation age gate; rows that omit them model
// pre-hibernation running records (never age-gated).
type RecordRow = {
  id?: string;
  deploymentId: string | null;
  kind: string;
  tenantId: string;
  status?: "running" | "awaiting";
  updatedAt?: Date;
  startedAt?: Date | null;
  pendingSignal?: {
    signalId: string;
    signalName: string;
    payload: unknown;
    receivedAt: string;
    redeliveries?: number;
  } | null;
};

// db whose select(...).from(...).where(...) resolves to the given rows —
// matching the reconciler's query shape (no orderBy). reconcileAll issues two
// selects: `workflowRun` (registry → deploy principal per kind+tenant) and
// `workflowRunRecord` (the non-terminal per-run records to re-establish); the
// `from` table identity disambiguates which result set to hand back.
function makeDb(rows: Row[], recordRows: RecordRow[] = []): HubDb {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(table === workflowRunRecord ? recordRows : rows),
      }),
    }),
  } as unknown as HubDb;
}

// Deps the reconcileAll/start tests don't exercise but the factory now
// requires. failOrphanedRuns has its own dedicated db + deps below.
const RECONCILE_ONLY_DEPS = {
  getRoutableAddresses: () => [],
  deploymentDomain: "abklabs.com",
  reclaimDeployment: () => Promise.resolve(),
  sendAgentUndeploy: () => Promise.resolve(),
  sendSignalDeliver: () => {},
};

type RunRow = {
  id: string;
  deploymentId: string | null;
  status: "provisioning" | "running" | "awaiting" | "completed" | "failed";
};

// Stateful db for failOrphanedRuns. The select serves the stuck-run candidates;
// the reconciler marks a genuinely-interrupted `running` run terminal via the
// mocked setRunStatus (CL-2669), which writes back to this same `rows` map by
// runId — so a test asserts the real status transition, not a mock.
function makeFailDb(runs: RunRow[]) {
  const rows = new Map<string, RunRow & { status: string }>(
    runs.map((r) => [r.id, { ...r }]),
  );
  // The mocked setRunStatus writes against this map (CL-2669).
  failRowsRef = rows;
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            [...rows.values()].map((r) => ({
              id: r.id,
              deploymentId: r.deploymentId,
              status: r.status,
            })),
          ),
      }),
    }),
  } as unknown as HubDb;
  return { db, rows };
}

// events stub capturing the agent.reconnected handler so the test can fire it.
function makeEvents() {
  let handler: (() => void) | undefined;
  const events = {
    on: mock((_type: string, fn: () => void) => {
      handler = fn;
      return () => {};
    }),
  } as unknown as SidecarRouter["events"];
  return {
    events,
    fireReconnect() {
      if (handler === undefined)
        throw new Error("no agent.reconnected handler registered");
      handler();
    },
  };
}

describe("createWorkflowReconciler", () => {
  it("re-establishes each non-terminal run's OWN per-run deployment, recovering the deploy principal from the kind's registry row (CL-2582)", async () => {
    const calls: {
      deploymentId: string;
      kind: string;
      tenantId: string;
      creatorPrincipalId: string;
    }[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      calls.push({
        deploymentId: args.deploymentId,
        kind: args.kind,
        tenantId: args.tenantId,
        creatorPrincipalId: args.creatorPrincipalId,
      });
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        // Registry rows: supply the DEPLOY principal per kind+tenant. Their own
        // `ses_op_*` deploymentId is the operator's shared deployment and is
        // NEVER re-established under per-run.
        [
          {
            deploymentId: "ses_op_a",
            kind: "pain-point-collateral",
            tenantId: "t1",
            principalId: "deployer1",
          },
          {
            deploymentId: "ses_op_b",
            kind: "deck",
            tenantId: "t2",
            principalId: "deployer2",
          },
        ],
        // Per-run records: the deployments that actually ran, each with its OWN
        // id. The null-deploymentId record is skipped.
        [
          {
            deploymentId: "ses_run_a",
            kind: "pain-point-collateral",
            tenantId: "t1",
          },
          { deploymentId: null, kind: "pain-point-collateral", tenantId: "t1" },
          { deploymentId: "ses_run_b", kind: "deck", tenantId: "t2" },
        ],
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    await reconciler.reconcileAll();

    // Each per-run deployment re-established with the DEPLOY principal (recovered
    // from the registry by kind+tenant — NOT the run owner). The operator's
    // shared ses_op_* deployments are never touched.
    expect(calls).toEqual([
      {
        deploymentId: "ses_run_a",
        kind: "pain-point-collateral",
        tenantId: "t1",
        creatorPrincipalId: "deployer1",
      },
      {
        deploymentId: "ses_run_b",
        kind: "deck",
        tenantId: "t2",
        creatorPrincipalId: "deployer2",
      },
    ]);
  });

  it("skips a record whose kind has no registry row (undeployed since the run started)", async () => {
    const seen: string[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      seen.push(args.deploymentId);
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        [
          {
            deploymentId: "ses_op",
            kind: "live",
            tenantId: "t",
            principalId: "deployer",
          },
        ],
        [
          { deploymentId: "ses_run_live", kind: "live", tenantId: "t" },
          // its kind has no registry row → no deploy principal → skipped
          { deploymentId: "ses_run_orphan", kind: "undeployed", tenantId: "t" },
        ],
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    await reconciler.reconcileAll();

    expect(seen).toEqual(["ses_run_live"]);
  });

  it("is best-effort: one deployment failing does not abort the pass", async () => {
    const seen: string[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      seen.push(args.deploymentId);
      if (args.deploymentId === "ses_run_a")
        return Promise.reject(new Error("boom"));
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        [
          {
            deploymentId: "ses_op",
            kind: "k",
            tenantId: "t",
            principalId: "p",
          },
        ],
        [
          { deploymentId: "ses_run_a", kind: "k", tenantId: "t" },
          { deploymentId: "ses_run_b", kind: "k", tenantId: "t" },
        ],
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    await reconciler.reconcileAll();

    expect(seen).toEqual(["ses_run_a", "ses_run_b"]);
  });

  it("reconciles on agent.reconnected, coalescing concurrent triggers into one pass", async () => {
    let resolveEnsure: (() => void) | undefined;
    let ensureCalls = 0;
    const ensure: EnsureDeploymentRoutableFn = () => {
      ensureCalls += 1;
      return new Promise((resolve) => {
        resolveEnsure = () => resolve({ reestablished: true });
      });
    };
    const evt = makeEvents();
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        [
          {
            deploymentId: "ses_op",
            kind: "k",
            tenantId: "t",
            principalId: "p",
          },
        ],
        [{ deploymentId: "ses_run_a", kind: "k", tenantId: "t" }],
      ),
      events: evt.events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    reconciler.start();

    // Two reconnect events while the first pass is still in flight must not
    // start a second pass — the in-flight pass already covers the deployment.
    evt.fireReconnect();
    evt.fireReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureCalls).toBe(1);
    resolveEnsure?.();
  });

  it("start() subscribes to agent.reconnected", () => {
    const evt = makeEvents();
    const reconciler = createWorkflowReconciler({
      db: makeDb([]),
      events: evt.events,
      ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
      ...RECONCILE_ONLY_DEPS,
    });
    reconciler.start();
    expect(evt.events.on).toHaveBeenCalledWith(
      "agent.reconnected",
      expect.any(Function),
    );
  });
});

const DOMAIN = "abklabs.com";
const noopEnsure: EnsureDeploymentRoutableFn = () =>
  Promise.resolve({ reestablished: false });

describe("failOrphanedRuns", () => {
  it("fails a run whose supervisor is NOT routable", async () => {
    const runs: RunRow[] = [
      { id: "run_1", deploymentId: "ses_gone", status: "running" },
    ];
    const { db, rows } = makeFailDb(runs);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_1")!.status).toBe("failed");
  });

  it("leaves a running run whose supervisor IS routable untouched (safety invariant)", async () => {
    const runs: RunRow[] = [
      { id: "run_live", deploymentId: "ses_live", status: "running" },
    ];
    // ses_live's supervisor IS in the routable snapshot — never fail it.
    const { db, rows } = makeFailDb(runs);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [`ins_ses_live@${DOMAIN}`],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_live")!.status).toBe("running");
  });

  it("leaves an awaitSignal-parked (awaiting) run untouched even when its supervisor is NOT routable (CL-2575)", async () => {
    // The regression fix: a run parked at an awaitSignal gate is resumable
    // across a restart (CL-2535/2537). failOrphanedRuns must NOT fail it even
    // though its supervisor is absent from the pre-reconcile routable snapshot —
    // failing it would flip the record terminal, drop the deployment out of
    // activeRunDeploymentIds, and make the run look reapable while it is
    // still parked → resume push dangles → reason=corrupt.
    const runs: RunRow[] = [
      { id: "run_parked", deploymentId: "ses_gone", status: "awaiting" },
    ];
    // Seed the dequeue with run_parked so this test is RED on the pre-fix code:
    // without the CL-2575 status guard, this non-routable run reaches
    // loadRunRecord and is marked failed. The guard skips it BEFORE
    // loadRunRecord, so on the fixed code findFirst is never called and the
    // seeded id is simply never consumed → the run stays awaiting. (Single
    // candidate, so the order-based dequeue cannot serve the wrong row.)
    const { db, rows } = makeFailDb(runs);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_parked")!.status).toBe("awaiting");
  });

  it("fails a run stranded in `provisioning` (deploymentless) by a crash mid-provision (CL-2755)", async () => {
    // A run seeded `provisioning` (async start, CL-2755) whose hub crashed before
    // the deployment was minted has a null deployment and no live supervisor — it
    // can never resume, so the boot sweep must fail it (never leave it stuck
    // provisioning forever), exactly like an interrupted `running` run.
    const runs: RunRow[] = [
      { id: "run_prov", deploymentId: null, status: "provisioning" },
      // Cross-run isolation: a routable running run alongside it is untouched.
      { id: "run_live", deploymentId: "ses_live", status: "running" },
    ];
    const { db, rows } = makeFailDb(runs);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [`ins_ses_live@${DOMAIN}`],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_prov")!.status).toBe("failed");
    expect(rows.get("run_live")!.status).toBe("running");
  });

  it("is idempotent: a second pass with no in-flight rows fails nothing", async () => {
    // After the first pass marks the row failed, the real query would no
    // longer return it (status NOT IN running/awaiting). Model that as an
    // empty candidate set: the pass must complete without writing anything.
    const { db, rows } = makeFailDb([]);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.size).toBe(0);
  });
});

describe("reclaimOrphanedDeployments (CL-2582 Step D janitor)", () => {
  // db whose workflowRunRecord query returns the given recent-terminal rows, and
  // whose agentInstance query returns `liveRows` (the per-deploymentId liveness
  // check). The mock can't read the LIKE arg, so each test uses a uniform
  // liveness answer to exercise one branch.
  function makeJanitorDb(
    terminal: { deploymentId: string | null; tenantId: string }[],
    liveRows: { id: string }[],
  ): HubDb {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === intxSchema.agentInstance) {
              return { limit: () => Promise.resolve(liveRows) };
            }
            return Promise.resolve(terminal);
          },
        }),
      }),
    } as unknown as HubDb;
  }

  it("reclaims a terminal run's deployment that still has live instances (teardown didn't fire)", async () => {
    const calls: { deploymentId: string; tenantId: string }[] = [];
    const reconciler = createWorkflowReconciler({
      db: makeJanitorDb(
        [{ deploymentId: "ses_run_x", tenantId: "t1" }],
        [{ id: "ins_ses_run_x" }], // still live → orphan
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: (args) => {
        calls.push({
          deploymentId: args.deploymentId,
          tenantId: args.tenantId,
        });
        return Promise.resolve();
      },
    });

    await reconciler.reclaimOrphanedDeployments();

    expect(calls).toEqual([{ deploymentId: "ses_run_x", tenantId: "t1" }]);
  });

  it("does NOT reclaim a terminal run whose deployment has no live instances (teardown already ran)", async () => {
    let reclaimCount = 0;
    const reconciler = createWorkflowReconciler({
      db: makeJanitorDb(
        [{ deploymentId: "ses_run_done", tenantId: "t1" }],
        [], // no live instances → already reclaimed → skip
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
      reclaimDeployment: () => {
        reclaimCount += 1;
        return Promise.resolve();
      },
    });

    await reconciler.reclaimOrphanedDeployments();

    expect(reclaimCount).toBe(0);
  });
});

describe("reconcileAwaiting — batch resilience + fail-loud (CL-2756)", () => {
  // The mock db returns the seeded record rows for the awaiting query (the real
  // SQL awaiting-scope filter is proven in the PGlite integration test); here we
  // exercise the batch/counting/error-surfacing logic over those candidates.
  it("surfaces an establish failure (counts it) yet still pre-warms the rest of the batch", async () => {
    const calls: string[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      calls.push(args.deploymentId);
      if (args.deploymentId === "ses_run_bad") {
        return Promise.reject(new Error("sidecar deploy frame rejected"));
      }
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        [
          {
            deploymentId: "ses_op",
            kind: "attio-task",
            tenantId: "t1",
            principalId: "deployer1",
          },
        ],
        [
          {
            deploymentId: "ses_run_bad",
            kind: "attio-task",
            tenantId: "t1",
            status: "awaiting" as const,
            updatedAt: new Date(),
          },
          {
            deploymentId: "ses_run_ok",
            kind: "attio-task",
            tenantId: "t1",
            status: "awaiting" as const,
            updatedAt: new Date(),
          },
        ],
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
    });

    const summary = await reconciler.reconcileAwaiting();

    // Both attempted (a failure never aborts the batch), the failure is counted
    // (surfaced, not swallowed as success), the healthy one re-established.
    expect(calls).toEqual(["ses_run_bad", "ses_run_ok"]);
    expect(summary.failed).toBe(1);
    expect(summary.reestablished).toBe(1);
  });
});

describe("reconcileAwaiting — hibernation of long-parked runs", () => {
  const GRACE_MS = 60_000;
  const KIND = "deck";
  const REGISTRY: Row[] = [
    { deploymentId: "ses_op", kind: KIND, tenantId: "t1", principalId: "dep1" },
  ];

  const REDELIVERY_DELAY_MS = 30_000;

  function parkedRecord(
    deploymentId: string,
    parkedForMs: number,
    pendingSignal?: RecordRow["pendingSignal"],
    startedAt?: Date | null,
  ): RecordRow {
    return {
      id: `run_${deploymentId}`,
      deploymentId,
      kind: KIND,
      tenantId: "t1",
      status: "awaiting",
      updatedAt: new Date(Date.now() - parkedForMs),
      startedAt:
        startedAt === undefined
          ? new Date(Date.now() - parkedForMs)
          : startedAt,
      pendingSignal: pendingSignal ?? null,
    };
  }

  function addressOf(deploymentId: string): string {
    return `ins_${deploymentId}@${DOMAIN}`;
  }

  function makeHarness(opts: {
    records: RecordRow[];
    routable: string[];
    undeployError?: Error;
    // Per-record override of the CAS re-read the hibernate branch performs;
    // defaults to a re-read that matches the decision read (CAS passes).
    casOverride?: Map<string, CasRow>;
    maxSignalRedeliveries?: number;
  }) {
    pendingRefreshes.length = 0;
    refreshResultRef = true;
    casRowsRef = new Map(
      opts.records
        .filter((r) => r.id !== undefined)
        .map((r) => [
          r.id as string,
          {
            status: r.status ?? "running",
            updatedAt: r.updatedAt ?? new Date(),
            pendingSignal: r.pendingSignal ?? null,
          },
        ]),
    );
    if (opts.casOverride) {
      for (const [id, row] of opts.casOverride) casRowsRef.set(id, row);
    }
    const ensured: string[] = [];
    const undeploys: { agentAddress: string; reason: string }[] = [];
    const sentSignals: {
      agentAddress: string;
      runId: string;
      signalName: string;
      signalId: string;
      payload: unknown;
    }[] = [];
    const reconciler = createWorkflowReconciler({
      db: makeDb(REGISTRY, opts.records),
      events: makeEvents().events,
      ensureDeploymentRoutable: (args) => {
        ensured.push(args.deploymentId);
        return Promise.resolve({ reestablished: true });
      },
      getRoutableAddresses: () => opts.routable,
      deploymentDomain: DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
      sendAgentUndeploy: (agentAddress, reason) => {
        undeploys.push({ agentAddress, reason });
        if (opts.undeployError) return Promise.reject(opts.undeployError);
        return Promise.resolve();
      },
      sendSignalDeliver: (args) => {
        sentSignals.push(args);
      },
      hibernationGraceMs: GRACE_MS,
      signalRedeliveryDelayMs: REDELIVERY_DELAY_MS,
      ...(opts.maxSignalRedeliveries !== undefined
        ? { maxSignalRedeliveries: opts.maxSignalRedeliveries }
        : {}),
    });
    return { reconciler, ensured, undeploys, sentSignals };
  }

  it("hibernates a routable deployment parked past the grace (sends the hibernate undeploy, never a deploy frame)", async () => {
    const h = makeHarness({
      records: [parkedRecord("ses_run_old", GRACE_MS * 10)],
      routable: [addressOf("ses_run_old")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.undeploys).toEqual([
      {
        agentAddress: addressOf("ses_run_old"),
        reason: WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
      },
    ]);
    expect(h.ensured).toEqual([]);
    expect(summary.hibernated).toBe(1);
    expect(summary.alreadyRoutable).toBe(0);
  });

  it("leaves a routable deployment parked under the grace alone (no hibernate, no re-establish)", async () => {
    const h = makeHarness({
      records: [parkedRecord("ses_run_fresh", GRACE_MS / 2)],
      routable: [addressOf("ses_run_fresh")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.undeploys).toEqual([]);
    expect(h.ensured).toEqual([]);
    expect(summary.alreadyRoutable).toBe(1);
    expect(summary.hibernated).toBe(0);
  });

  it("leaves an unroutable deployment parked past the grace dormant — wake is signal-driven, never the pre-warm", async () => {
    const h = makeHarness({
      records: [parkedRecord("ses_run_dormant", GRACE_MS * 10)],
      routable: [],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.ensured).toEqual([]);
    expect(h.undeploys).toEqual([]);
    expect(summary.dormant).toBe(1);
    expect(summary.reestablished).toBe(0);
  });

  it("still pre-warms an unroutable deployment parked under the grace (crash-recovery backstop)", async () => {
    const h = makeHarness({
      records: [parkedRecord("ses_run_young", GRACE_MS / 2)],
      routable: [],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.ensured).toEqual(["ses_run_young"]);
    expect(summary.reestablished).toBe(1);
    expect(summary.dormant).toBe(0);
  });

  it("surfaces a hibernate teardown failure (counts it) and keeps sweeping the batch", async () => {
    const h = makeHarness({
      records: [
        parkedRecord("ses_run_bad", GRACE_MS * 10),
        parkedRecord("ses_run_young", GRACE_MS / 2),
      ],
      routable: [addressOf("ses_run_bad")],
      undeployError: new Error("sidecar gone"),
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(summary.failed).toBe(1);
    expect(summary.hibernated).toBe(0);
    // The rest of the batch is still swept: the young unroutable record is
    // pre-warmed despite the earlier hibernate failure.
    expect(h.ensured).toEqual(["ses_run_young"]);
  });

  it("wakes a dormant run with a stale pending signal and re-delivers it (a 202-accepted signal is never lost)", async () => {
    const pending = {
      signalId: "sig-lost",
      signalName: "approval",
      payload: { approved: true },
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_pending", GRACE_MS * 10, pending)],
      routable: [],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    // Wake despite being past the grace: a pending signal overrides dormancy.
    expect(h.ensured).toEqual(["ses_run_pending"]);
    expect(h.sentSignals).toEqual([
      {
        agentAddress: addressOf("ses_run_pending"),
        runId: "run_ses_run_pending",
        signalName: "approval",
        signalId: "sig-lost",
        payload: { approved: true },
      },
    ]);
    expect(summary.redelivered).toBe(1);
    expect(summary.dormant).toBe(0);
    expect(h.undeploys).toEqual([]);
    // The re-delivery refreshes the pending record's timestamp (same
    // signalId), so the next pass backs off for another delay window
    // instead of re-delivering and re-waking on every tick forever.
    expect(pendingRefreshes).toHaveLength(1);
    expect(pendingRefreshes[0]?.runId).toBe("run_ses_run_pending");
    expect(pendingRefreshes[0]?.signalId).toBe("sig-lost");
    const refreshed = pendingRefreshes[0]?.receivedAt;
    expect(refreshed).toBeString();
    if (refreshed !== undefined) {
      expect(Date.now() - Date.parse(refreshed)).toBeLessThan(5_000);
    }
  });

  it("holds a pending signal for a run that has not started yet (startedAt null), never delivers, and stays pendingHandled (CL-3641)", async () => {
    const pending = {
      signalId: "sig-not-started",
      signalName: "intake",
      payload: { intake: true },
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const h = makeHarness({
      records: [
        parkedRecord("ses_run_unstarted", GRACE_MS * 10, pending, null),
      ],
      routable: [addressOf("ses_run_unstarted")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.sentSignals).toEqual([]);
    expect(summary.redelivered).toBe(0);
    // pendingHandled still blocks hibernation even though nothing was
    // delivered — the record is retried, not torn down, on the next pass.
    expect(h.undeploys).toEqual([]);
    expect(summary.hibernated).toBe(0);
  });

  it("delivers the same pending signal once startedAt is set (run has provably started)", async () => {
    const pending = {
      signalId: "sig-now-started",
      signalName: "intake",
      payload: { intake: true },
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const h = makeHarness({
      records: [
        parkedRecord(
          "ses_run_started",
          GRACE_MS * 10,
          pending,
          new Date(Date.now() - 1_000),
        ),
      ],
      routable: [addressOf("ses_run_started")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.sentSignals).toEqual([
      {
        agentAddress: addressOf("ses_run_started"),
        runId: "run_ses_run_started",
        signalName: "intake",
        signalId: "sig-now-started",
        payload: { intake: true },
      },
    ]);
    expect(summary.redelivered).toBe(1);
  });

  it("gives a freshly-accepted pending signal time to land (no immediate re-delivery) and never hibernates a pending-signal run", async () => {
    const pending = {
      signalId: "sig-in-flight",
      signalName: "approval",
      payload: {},
      receivedAt: new Date().toISOString(),
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_landing", GRACE_MS * 10, pending)],
      routable: [addressOf("ses_run_landing")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    // Routable and past the grace, but a signal is in flight: neither
    // hibernated nor re-delivered this tick — the projection will clear the
    // pending signal when SignalReceived folds, or the next tick re-delivers.
    expect(h.undeploys).toEqual([]);
    expect(h.sentSignals).toEqual([]);
    expect(summary.hibernated).toBe(0);
    expect(summary.redelivered).toBe(0);
  });

  it("skips the re-delivery when the conditional refresh finds the record already cleared (no resurrection, no duplicate)", async () => {
    const pending = {
      signalId: "sig-cleared",
      signalName: "approval",
      payload: {},
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_cleared", GRACE_MS * 10, pending)],
      routable: [],
    });
    // The projection cleared the record (receipt folded) between the
    // reconciler's select and its refresh: the conditional write hits zero
    // rows, so nothing must be dispatched.
    refreshResultRef = false;

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.sentSignals).toEqual([]);
    expect(summary.redelivered).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("re-delivers a stale pending signal even after the resume path's optimistic running flip", async () => {
    // resumeWorkflowRun optimistically flips the record to `running` before
    // the signal lands; a lost signal leaves a routable supervisor with
    // progress, which the liveness sweep never fails. The pending-signal
    // scan therefore covers running records too — the signal is what clears
    // it, not the status.
    const pending = {
      signalId: "sig-optimistic",
      signalName: "approval",
      payload: { ok: true },
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const rec = parkedRecord("ses_run_flip", GRACE_MS * 10, pending);
    rec.status = "running";
    const h = makeHarness({
      records: [rec],
      routable: [addressOf("ses_run_flip")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.sentSignals).toEqual([
      {
        agentAddress: addressOf("ses_run_flip"),
        runId: "run_ses_run_flip",
        signalName: "approval",
        signalId: "sig-optimistic",
        payload: { ok: true },
      },
    ]);
    expect(summary.redelivered).toBe(1);
    expect(h.undeploys).toEqual([]);
  });

  it("neither hibernates nor re-delivers a run carrying a MALFORMED pending signal (fail loud, act on neither rail)", async () => {
    const rec = parkedRecord("ses_run_garbled", GRACE_MS * 10);
    rec.pendingSignal = {
      bogus: true,
    } as unknown as NonNullable<RecordRow["pendingSignal"]>;
    const h = makeHarness({
      records: [rec],
      routable: [addressOf("ses_run_garbled")],
    });

    const summary = await h.reconciler.reconcileAwaiting();

    // Malformed ≠ absent: the raw column is non-null, so the run must not be
    // hibernated (a signal may be in flight behind the corruption), and the
    // unparseable record cannot be re-delivered either.
    expect(h.undeploys).toEqual([]);
    expect(h.sentSignals).toEqual([]);
    expect(summary.hibernated).toBe(0);
    expect(summary.redelivered).toBe(0);
  });

  it("skips the hibernate when the CAS re-read shows the run resumed since the decision read", async () => {
    const rec = parkedRecord("ses_run_racing", GRACE_MS * 10);
    const h = makeHarness({
      records: [rec],
      routable: [addressOf("ses_run_racing")],
      casOverride: new Map([
        [
          "run_ses_run_racing",
          {
            status: "running",
            updatedAt: new Date(),
            pendingSignal: null,
          },
        ],
      ]),
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.undeploys).toEqual([]);
    expect(summary.hibernated).toBe(0);
  });

  it("skips the hibernate when the CAS re-read shows the record advanced (updatedAt changed) even if still awaiting", async () => {
    const rec = parkedRecord("ses_run_advanced", GRACE_MS * 10);
    const h = makeHarness({
      records: [rec],
      routable: [addressOf("ses_run_advanced")],
      casOverride: new Map([
        [
          "run_ses_run_advanced",
          {
            status: "awaiting",
            updatedAt: new Date(),
            pendingSignal: null,
          },
        ],
      ]),
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.undeploys).toEqual([]);
    expect(summary.hibernated).toBe(0);
  });

  it("dead-letters a run once its pending signal exhausts the redelivery cap (never delivers, never hibernates, marks the run failed)", async () => {
    const pending = {
      signalId: "sig-exhausted",
      signalName: "approval",
      payload: {},
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
      redeliveries: 3,
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_exhausted", GRACE_MS * 10, pending)],
      routable: [addressOf("ses_run_exhausted")],
      maxSignalRedeliveries: 3,
    });
    failRowsRef = new Map([["run_ses_run_exhausted", { status: "awaiting" }]]);

    const summary = await h.reconciler.reconcileAwaiting();

    expect(h.sentSignals).toEqual([]);
    expect(h.ensured).toEqual([]);
    expect(h.undeploys).toEqual([]);
    expect(summary.redelivered).toBe(0);
    expect(summary.deadLettered).toBe(1);
    expect(failRowsRef.get("run_ses_run_exhausted")?.status).toBe("failed");
  });

  it("increments `redeliveries` on the refreshed pending signal below the cap", async () => {
    const pending = {
      signalId: "sig-counting",
      signalName: "approval",
      payload: {},
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
      redeliveries: 2,
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_counting", GRACE_MS * 10, pending)],
      routable: [addressOf("ses_run_counting")],
      maxSignalRedeliveries: 10,
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(summary.redelivered).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(pendingRefreshes).toHaveLength(1);
    expect(pendingRefreshes[0]?.redeliveries).toBe(3);
  });

  it("parses a legacy pending signal with no `redeliveries` field and treats it as 0 (delivers, does not dead-letter)", async () => {
    const legacyPending = {
      signalId: "sig-legacy",
      signalName: "approval",
      payload: {},
      receivedAt: new Date(Date.now() - REDELIVERY_DELAY_MS * 2).toISOString(),
    };
    const h = makeHarness({
      records: [parkedRecord("ses_run_legacy", GRACE_MS * 10, legacyPending)],
      routable: [addressOf("ses_run_legacy")],
      maxSignalRedeliveries: 3,
    });

    const summary = await h.reconciler.reconcileAwaiting();

    expect(summary.redelivered).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(h.sentSignals).toHaveLength(1);
    expect(pendingRefreshes[0]?.redeliveries).toBe(1);
  });
});

describe("hibernate reason protocol constant stays byte-identical across packages", () => {
  it("hub reconciler and hub-agent link carry the same literal", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const repoRoot = join(import.meta.dir, "../../../..");
    const extract = (source: string, file: string): string => {
      const match = source.match(
        /WORKFLOW_HIBERNATE_UNDEPLOY_REASON =\s*\n?\s*"([^"]+)"/,
      );
      if (match?.[1] === undefined) {
        throw new Error(
          `no WORKFLOW_HIBERNATE_UNDEPLOY_REASON literal in ${file}`,
        );
      }
      return match[1];
    };
    const hubSource = await readFile(
      join(repoRoot, "apps/hub/src/services/workflow-reconciler.ts"),
      "utf8",
    );
    const linkSource = await readFile(
      join(repoRoot, "packages/hub-agent/src/ws/hub-link.ts"),
      "utf8",
    );
    const hubLiteral = extract(hubSource, "workflow-reconciler.ts");
    const linkLiteral = extract(linkSource, "hub-link.ts");
    // Drift here silently downgrades hibernate to a FULL undeploy on the
    // sidecar (reclaim sweeps run, the parked run's repo is rm -rf'd).
    expect(hubLiteral).toBe(linkLiteral);
    expect(hubLiteral).toBe(WORKFLOW_HIBERNATE_UNDEPLOY_REASON);
  });
});

describe("reconcileAll — hibernated awaiting deployments stay down on reconnect", () => {
  const GRACE_MS = 60_000;

  it("skips awaiting records parked past the grace but still re-establishes running ones", async () => {
    const ensured: string[] = [];
    const reconciler = createWorkflowReconciler({
      db: makeDb(
        [
          {
            deploymentId: "ses_op",
            kind: "k",
            tenantId: "t",
            principalId: "p",
          },
        ],
        [
          {
            deploymentId: "ses_run_hibernated",
            kind: "k",
            tenantId: "t",
            status: "awaiting",
            updatedAt: new Date(Date.now() - GRACE_MS * 10),
          },
          {
            deploymentId: "ses_run_fresh_gate",
            kind: "k",
            tenantId: "t",
            status: "awaiting",
            updatedAt: new Date(),
          },
          {
            deploymentId: "ses_run_running",
            kind: "k",
            tenantId: "t",
            status: "running",
            updatedAt: new Date(Date.now() - GRACE_MS * 10),
          },
        ],
      ),
      events: makeEvents().events,
      ensureDeploymentRoutable: (args) => {
        ensured.push(args.deploymentId);
        return Promise.resolve({ reestablished: true });
      },
      ...RECONCILE_ONLY_DEPS,
      hibernationGraceMs: GRACE_MS,
    });

    await reconciler.reconcileAll();

    // A long-parked awaiting run stays hibernated across reconnect passes; a
    // freshly-parked gate and a running run are re-established as before.
    expect(ensured).toEqual(["ses_run_fresh_gate", "ses_run_running"]);
  });
});

describe("registerAwaitingSupervisorPrewarm (CL-2756 periodic backstop)", () => {
  it("drives reconcileAwaiting on its interval and stops cleanly", async () => {
    let ticks = 0;
    const stop = registerAwaitingSupervisorPrewarm({
      reconciler: {
        reconcileAwaiting: () => {
          ticks += 1;
          return Promise.resolve({
            candidates: 0,
            reestablished: 0,
            alreadyRoutable: 0,
            skippedNoPrincipal: 0,
            failed: 0,
            hibernated: 0,
            dormant: 0,
            redelivered: 0,
            deadLettered: 0,
          });
        },
      },
      intervalMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    const afterStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(afterStop).toBeGreaterThanOrEqual(1);
    expect(ticks).toBe(afterStop); // no ticks fire after stop()
  });
});
