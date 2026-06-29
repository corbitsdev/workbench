import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { getLogger } from "@intx/log";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";
import { createRunStore, loadRunRecord } from "../workflow-executor/run-store";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";

const log = getLogger(["services", "workflow-reconciler"]);

// Hub-as-control-plane reconciliation of workflow supervisor deployments.
//
// A multi-step supervisor's address lives only in the hub's in-memory
// addressIndex (set at deploy time) and is NOT re-advertised by the sidecar on
// register/reconnect — supervisors never run startSession, so they are absent
// from the sidecar's restorable-session set. The hub therefore loses every
// supervisor address on its own restart, and a sidecar restart tears down the
// supervisor child outright. The hub owns the source of truth (the workflow
// repo + DB rows), so it re-drives the supervisor deploy from that state rather
// than relying on the sidecar to restore itself.
//
// `ensureDeploymentRoutable` is idempotent and coalesced per deploymentId, so a
// reconcile pass is a cheap no-op for supervisors that are already routable.
//
// Caveats (documented honestly, not silently): (1) re-establishing a supervisor
// creates a live instance; under the "a deployed workflow has zero live
// instances" model these are transient and reaped by idle-harness eviction
// (CL-2219). (2) A run parked at an awaitSignal gate IS now resumable across a
// restart: CL-2535/2537 host-satisfies the resume — the sidecar self-discovers
// the parked run from disk and installs a live signal watcher that resumes it
// when the human signals. This reconciler re-establishes the supervisor so NEW
// runs work and so a parked run resumes end-to-end.
export interface WorkflowReconciler {
  // CL-2248: fail genuinely-interrupted `workflow_run_record` rows whose
  // supervisor is NOT routable. MUST be called on hub startup BEFORE
  // `reconcileAll()`, while the routable snapshot still reflects only sessions
  // the sidecar restored on its own — once `reconcileAll()` re-registers
  // supervisors, every run would look routable and nothing would be failed.
  //
  // CL-2575: only `running` (mid-execution) runs are failed. A run parked at an
  // awaitSignal gate (`awaiting`) is NOT failed — CL-2535/2537 made it resumable
  // across a restart (the sidecar self-discovers it and resumes on signal).
  // Failing an `awaiting` run flips its record terminal, which drops its
  // deployment out of `activeRunDeploymentIds`; the sidecar boot-reconciler then
  // reaps the deployment's `workflow-runs/<slug>` repo out from under the live
  // watcher, so the resume push ships a pack whose base is gone →
  // `pack_walk_dangling_parent` → `reason=corrupt`, retried forever (CL-2575).
  // Idempotent: already-terminal rows are not selected.
  failOrphanedRuns(): Promise<void>;
  // Re-establish supervisors for every active (non-deleted) deployment. Run on
  // hub startup and on sidecar reconnect. Best-effort: a single deployment's
  // failure is logged and never aborts the pass.
  reconcileAll(): Promise<void>;
  // Subscribe to sidecar reconnect events and reconcile on each (coalesced to
  // one in-flight pass). Returns an unsubscribe handle.
  start(): () => void;
}

export function createWorkflowReconciler(deps: {
  db: HubDb;
  events: SidecarRouter["events"];
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  deploymentDomain: string;
}): WorkflowReconciler {
  // Single-flight guard. A sidecar restart fires one agent.reconnected per
  // restored address, and the hub-startup pass can overlap any of them. The
  // guard lives in reconcileAll itself (not just the reconnect wrapper) so the
  // startup call and a reconnect-triggered call cannot run concurrent passes —
  // an overlapping trigger returns immediately and the in-flight pass covers it
  // (ensureDeploymentRoutable no-ops already-routable deployments). A trigger
  // arriving just after the flag clears starts a fresh pass, which is the
  // intended backstop behavior.
  let reconciling = false;

  async function failOrphanedRuns(): Promise<void> {
    // Snapshot the routable set BEFORE any re-registration. The safety
    // invariant: a run whose supervisor IS in this snapshot is never failed.
    const routable = new Set(deps.getRoutableAddresses());

    const stuckRuns = await deps.db
      .select({
        id: workflowRunRecord.id,
        deploymentId: workflowRunRecord.deploymentId,
        status: workflowRunRecord.status,
      })
      .from(workflowRunRecord)
      .where(
        and(
          inArray(workflowRunRecord.status, ["running", "awaiting"]),
          isNull(workflowRunRecord.deletedAt),
        ),
      );

    if (stuckRuns.length === 0) return;

    const runStore = createRunStore(deps.db);
    let failed = 0;
    let preservedParked = 0;
    for (const run of stuckRuns) {
      // CL-2575: this is THE resumability decision. A run parked at an
      // awaitSignal gate (`awaiting`) is resumable across a restart — CL-2535/
      // 2537 host-satisfies it (the sidecar self-discovers the parked run from
      // disk and resumes on signal). Failing it would flip its record terminal,
      // drop the deployment out of `activeRunDeploymentIds`, and let the sidecar
      // boot-reconciler reap the `workflow-runs/<slug>` repo out from under the
      // live watcher → the resume push ships a pack whose base is gone →
      // `pack_walk_dangling_parent` → `reason=corrupt`, retried forever. Only a
      // genuinely-interrupted `running` run is unrecoverable, so only it is
      // failed. (The query selects both statuses so this single in-loop branch
      // owns the decision and is unit-testable; awaiting runs are few.)
      if (run.status !== "running") {
        preservedParked += 1;
        continue;
      }
      // A run with no deployment can never have a routable supervisor, so it
      // is unconditionally orphaned by a restart.
      const supervisorAddress =
        run.deploymentId === null
          ? null
          : deriveDeploymentAddress({
              deploymentId: run.deploymentId,
              deploymentDomain: deps.deploymentDomain,
            });
      if (supervisorAddress !== null && routable.has(supervisorAddress))
        continue;

      try {
        const state = await loadRunRecord(deps.db, run.id);
        if (state === null) continue;
        state.status = "failed";
        state.error = "interrupted by restart";
        await runStore.save(state);
        failed += 1;
      } catch (err) {
        log.warn("failOrphanedRuns: failed to mark run failed", {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failed > 0 || preservedParked > 0) {
      log.info("failOrphanedRuns: marked interrupted runs failed", {
        candidates: stuckRuns.length,
        failed,
        // CL-2575: awaitSignal-parked runs left intact for the sidecar watcher
        // to resume — failing them would strand them with reason=corrupt.
        preservedParked,
      });
    }
  }

  async function reconcileAll(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const rows = await deps.db
        .select({
          deploymentId: workflowRun.deploymentId,
          kind: workflowRun.kind,
          tenantId: workflowRun.tenantId,
          principalId: workflowRun.principalId,
        })
        .from(workflowRun)
        .where(
          and(
            isNotNull(workflowRun.deploymentId),
            isNull(workflowRun.deletedAt),
          ),
        );

      // Only re-establish a supervisor for a deployment that still has work to
      // resume. A deployment whose run records are ALL terminal — `failed`
      // (e.g. `failOrphanedRuns` just marked it) or `completed` — needs no live
      // supervisor; re-establishing it re-spawns a child that replays a
      // dead/wedged run forever. That is the recurrence vector behind the
      // staging restart loop: `failOrphanedRuns` failed the run record, but
      // this pass re-established the deployment anyway (it keyed only off the
      // un-filtered `workflow_run` row), so the failed run was resurrected on
      // every sidecar reconnect. A deployment with NO record yet (freshly
      // deployed, never run) is deliberately left untouched — its supervisor
      // comes up on first run — so the only deployments SKIPPED are those that
      // have records and none are non-terminal.
      const recordRows = await deps.db
        .select({
          deploymentId: workflowRunRecord.deploymentId,
          status: workflowRunRecord.status,
        })
        .from(workflowRunRecord)
        .where(
          and(
            isNotNull(workflowRunRecord.deploymentId),
            isNull(workflowRunRecord.deletedAt),
          ),
        );
      const deploymentsWithRecord = new Set<string>();
      const deploymentsWithActiveRecord = new Set<string>();
      for (const r of recordRows) {
        if (r.deploymentId === null) continue;
        deploymentsWithRecord.add(r.deploymentId);
        if (r.status === "running" || r.status === "awaiting") {
          deploymentsWithActiveRecord.add(r.deploymentId);
        }
      }

      let reestablished = 0;
      let skippedTerminal = 0;
      for (const row of rows) {
        if (!row.deploymentId) continue;
        if (
          deploymentsWithRecord.has(row.deploymentId) &&
          !deploymentsWithActiveRecord.has(row.deploymentId)
        ) {
          skippedTerminal += 1;
          continue;
        }
        try {
          const result = await deps.ensureDeploymentRoutable({
            deploymentId: row.deploymentId,
            kind: row.kind,
            tenantId: row.tenantId,
            creatorPrincipalId: row.principalId,
          });
          if (result.reestablished) reestablished += 1;
        } catch (err) {
          log.warn("workflow reconcile: re-establish failed for deployment", {
            deploymentId: row.deploymentId,
            kind: row.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (reestablished > 0 || skippedTerminal > 0) {
        log.info("workflow reconcile pass complete", {
          active: rows.length,
          reestablished,
          skippedTerminal,
        });
      }
    } finally {
      reconciling = false;
    }
  }

  return {
    failOrphanedRuns,
    reconcileAll,
    start() {
      // The handler is awaited by the sidecar-handler's reconnect flow; it must
      // never throw, or it would fail the address's reconnection. reconcileAll is
      // self-guarded; fire-and-forget with an internal catch keeps this safe.
      return deps.events.on("agent.reconnected", () => {
        void reconcileAll().catch((err) => {
          log.warn("workflow reconcile pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    },
  };
}
