import { describe, expect, it, mock } from "bun:test";
import { schema as intxSchema } from "@intx/db";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import { createWorkflowReconciler } from "./workflow-reconciler";
import { workflowRunRecord } from "../db/schema";

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
type RecordRow = {
  deploymentId: string | null;
  kind: string;
  tenantId: string;
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
};

type RunRow = {
  id: string;
  deploymentId: string | null;
  status: "running" | "awaiting" | "completed" | "failed";
};

// Stateful db for failOrphanedRuns. The reconciler, for each NON-routable
// candidate, calls loadRunRecord (findFirst) then save (update) before moving
// to the next — so findFirst dequeues candidates in order and update writes
// back to the row findFirst just handed out. This round-trips the real
// status/error transition rather than asserting a mock.
//
// CAVEAT: findFirst serves by dequeue ORDER, not by the requested run id (the
// real loadRunRecord looks up by id; this mock cannot extract it from drizzle's
// SQL expression). So `nonRoutableIdsInOrder` MUST match the exact order the
// reconciler reaches loadRunRecord. Keep failOrphanedRuns tests to at most ONE
// served candidate (the others routable/awaiting/empty) so a mismatched order
// can never silently write to the wrong row — the failure mode that made a
// multi-candidate test pass on broken code (CL-2575 review).
function makeFailDb(runs: RunRow[], nonRoutableIdsInOrder: string[]) {
  const rows = new Map<string, RunRow & { error: string | null }>(
    runs.map((r) => [r.id, { ...r, error: null }]),
  );
  // The reconciler only calls loadRunRecord (findFirst) for NON-routable
  // candidates, in stuckRuns order. Seed the dequeue with exactly those.
  const pending = [...nonRoutableIdsInOrder];
  let lastHandedOut: string | null = null;
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
    query: {
      workflowRunRecord: {
        findFirst: () => {
          const id = pending.shift();
          if (id === undefined) {
            lastHandedOut = null;
            return Promise.resolve(undefined);
          }
          lastHandedOut = id;
          const r = rows.get(id)!;
          return Promise.resolve({
            id: r.id,
            deploymentId: r.deploymentId,
            kind: "k",
            tenantId: "t",
            principalId: "p",
            status: r.status,
            currentStepId: null,
            input: {},
            outputs: {},
            error: r.error,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          });
        },
      },
    },
    update: () => ({
      set: (vals: {
        status: "running" | "awaiting" | "completed" | "failed";
        error: string | null;
      }) => ({
        where: () => {
          if (lastHandedOut !== null) {
            const r = rows.get(lastHandedOut);
            if (r !== undefined) {
              r.status = vals.status;
              r.error = vals.error;
            }
          }
          return Promise.resolve();
        },
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
    const { db, rows } = makeFailDb(runs, ["run_1"]);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_1")!.status).toBe("failed");
    expect(rows.get("run_1")!.error).toBe("interrupted by restart");
  });

  it("leaves a running run whose supervisor IS routable untouched (safety invariant)", async () => {
    const runs: RunRow[] = [
      { id: "run_live", deploymentId: "ses_live", status: "running" },
    ];
    // ses_live's supervisor IS in the routable snapshot — never fail it.
    const { db, rows } = makeFailDb(runs, []);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [`ins_ses_live@${DOMAIN}`],
      deploymentDomain: DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_live")!.status).toBe("running");
    expect(rows.get("run_live")!.error).toBeNull();
  });

  it("leaves an awaitSignal-parked (awaiting) run untouched even when its supervisor is NOT routable (CL-2575)", async () => {
    // The regression fix: a run parked at an awaitSignal gate is resumable
    // across a restart (CL-2535/2537). failOrphanedRuns must NOT fail it even
    // though its supervisor is absent from the pre-reconcile routable snapshot —
    // failing it would flip the record terminal, drop the deployment out of
    // activeRunDeploymentIds, and let the sidecar boot-reconciler reap the
    // workflow-run repo → resume push dangles → reason=corrupt.
    const runs: RunRow[] = [
      { id: "run_parked", deploymentId: "ses_gone", status: "awaiting" },
    ];
    // Seed the dequeue with run_parked so this test is RED on the pre-fix code:
    // without the CL-2575 status guard, this non-routable run reaches
    // loadRunRecord and is marked failed. The guard skips it BEFORE
    // loadRunRecord, so on the fixed code findFirst is never called and the
    // seeded id is simply never consumed → the run stays awaiting. (Single
    // candidate, so the order-based dequeue cannot serve the wrong row.)
    const { db, rows } = makeFailDb(runs, ["run_parked"]);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_parked")!.status).toBe("awaiting");
    expect(rows.get("run_parked")!.error).toBeNull();
  });

  it("is idempotent: a second pass with no in-flight rows fails nothing", async () => {
    // After the first pass marks the row failed, the real query would no
    // longer return it (status NOT IN running/awaiting). Model that as an
    // empty candidate set: the pass must complete without writing anything.
    const { db, rows } = makeFailDb([], []);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [],
      deploymentDomain: DOMAIN,
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
      reclaimDeployment: () => {
        reclaimCount += 1;
        return Promise.resolve();
      },
    });

    await reconciler.reclaimOrphanedDeployments();

    expect(reclaimCount).toBe(0);
  });
});
