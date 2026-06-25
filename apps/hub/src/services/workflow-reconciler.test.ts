import { describe, expect, it, mock } from "bun:test";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import { createWorkflowReconciler } from "./workflow-reconciler";

type Row = {
  deploymentId: string | null;
  kind: string;
  tenantId: string;
  principalId: string;
};

// db whose select(...).from(...).where(...) resolves to the given active rows —
// matching the reconciler's query shape (no orderBy).
function makeDb(rows: Row[]): HubDb {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as HubDb;
}

// Deps the reconcileAll/start tests don't exercise but the factory now
// requires. failOrphanedRuns has its own dedicated db + deps below.
const RECONCILE_ONLY_DEPS = {
  getRoutableAddresses: () => [],
  deploymentDomain: "abklabs.com",
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
  it("re-establishes every active deployment, skipping rows without a deploymentId", async () => {
    const calls: {
      deploymentId: string;
      kind: string;
      tenantId: string;
    }[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      calls.push({
        deploymentId: args.deploymentId,
        kind: args.kind,
        tenantId: args.tenantId,
      });
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb([
        {
          deploymentId: "ses_a",
          kind: "pain-point-collateral",
          tenantId: "t1",
          principalId: "p1",
        },
        {
          deploymentId: null,
          kind: "orphan",
          tenantId: "t1",
          principalId: "p1",
        },
        {
          deploymentId: "ses_b",
          kind: "deck",
          tenantId: "t2",
          principalId: "p2",
        },
      ]),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual([
      { deploymentId: "ses_a", kind: "pain-point-collateral", tenantId: "t1" },
      { deploymentId: "ses_b", kind: "deck", tenantId: "t2" },
    ]);
  });

  it("is best-effort: one deployment failing does not abort the pass", async () => {
    const seen: string[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      seen.push(args.deploymentId);
      if (args.deploymentId === "ses_a")
        return Promise.reject(new Error("boom"));
      return Promise.resolve({ reestablished: true });
    };
    const reconciler = createWorkflowReconciler({
      db: makeDb([
        { deploymentId: "ses_a", kind: "k", tenantId: "t", principalId: "p" },
        { deploymentId: "ses_b", kind: "k", tenantId: "t", principalId: "p" },
      ]),
      events: makeEvents().events,
      ensureDeploymentRoutable: ensure,
      ...RECONCILE_ONLY_DEPS,
    });

    await reconciler.reconcileAll();

    expect(seen).toEqual(["ses_a", "ses_b"]);
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
      db: makeDb([
        { deploymentId: "ses_a", kind: "k", tenantId: "t", principalId: "p" },
      ]),
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
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_1")!.status).toBe("failed");
    expect(rows.get("run_1")!.error).toBe("interrupted by restart");
  });

  it("leaves a run whose supervisor IS routable untouched (safety invariant)", async () => {
    const runs: RunRow[] = [
      { id: "run_live", deploymentId: "ses_live", status: "awaiting" },
    ];
    // ses_live's supervisor IS in the routable snapshot — never fail it.
    const { db, rows } = makeFailDb(runs, []);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [`ins_ses_live@${DOMAIN}`],
      deploymentDomain: DOMAIN,
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_live")!.status).toBe("awaiting");
    expect(rows.get("run_live")!.error).toBeNull();
  });

  it("fails only the non-routable runs in a mixed set, keeping the routable one", async () => {
    const runs: RunRow[] = [
      { id: "run_live", deploymentId: "ses_live", status: "running" },
      { id: "run_gone", deploymentId: "ses_gone", status: "awaiting" },
    ];
    // run_live is routable (skipped, no findFirst); run_gone is the only
    // non-routable candidate, so it is the only id the dequeue serves.
    const { db, rows } = makeFailDb(runs, ["run_gone"]);
    const reconciler = createWorkflowReconciler({
      db,
      events: makeEvents().events,
      ensureDeploymentRoutable: noopEnsure,
      getRoutableAddresses: () => [`ins_ses_live@${DOMAIN}`],
      deploymentDomain: DOMAIN,
    });

    await reconciler.failOrphanedRuns();

    expect(rows.get("run_live")!.status).toBe("running");
    expect(rows.get("run_gone")!.status).toBe("failed");
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
    });

    await reconciler.failOrphanedRuns();

    expect(rows.size).toBe(0);
  });
});
