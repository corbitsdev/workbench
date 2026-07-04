import { and, gt, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";
import { setRunStatus } from "../workflow-executor/run-store";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import type { ReclaimDeploymentFn } from "./workflow-deploy";

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
  // Re-establish supervisors for every per-run deployment that still has a
  // non-terminal run record (CL-2582: the per-run deploymentId lives on the
  // record, not on `workflow_run`). Run on hub startup and on sidecar reconnect.
  // Best-effort: a single deployment's failure is logged and never aborts the
  // pass.
  reconcileAll(): Promise<void>;
  // CL-2582 Step D (class 2): reclaim per-run deployments whose run reached a
  // terminal status but whose teardown did not fire (the hub crashed between the
  // projection-bridge save and the fire-and-forget teardown). Bounded to runs
  // that terminated recently and gated on the deployment STILL having live
  // instance rows, so it is a cheap no-op for the normal case where teardown
  // already ran. Run on hub startup after `reconcileAll`.
  reclaimOrphanedDeployments(): Promise<void>;
  // Subscribe to sidecar reconnect events and reconcile on each (coalesced to
  // one in-flight pass). Returns an unsubscribe handle.
  start(): () => void;
}

// How far back the orphan janitor looks for terminated-but-not-torn-down runs.
// A hub crash between the terminal save and the teardown is recovered on the
// next boot; 24h covers any realistic restart gap while keeping the scan small.
const ORPHAN_RECLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createWorkflowReconciler(deps: {
  db: HubDb;
  events: SidecarRouter["events"];
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  deploymentDomain: string;
  // CL-2582: tear a terminal run's orphaned deployment down (class 2 janitor).
  reclaimDeployment: ReclaimDeploymentFn;
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
          // CL-2755: `provisioning` runs are swept too — a run seeded before its
          // deployment existed and stranded by a hub crash mid-provision has no
          // live supervisor and can never resume, so it must be failed like an
          // interrupted `running` run. `awaiting` is preserved (CL-2575).
          inArray(workflowRunRecord.status, [
            "provisioning",
            "running",
            "awaiting",
          ]),
          isNull(workflowRunRecord.deletedAt),
        ),
      );

    if (stuckRuns.length === 0) return;

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
      // Only `awaiting` is resumable across a restart and preserved (CL-2575);
      // `running` and `provisioning` (CL-2755) are both failable when orphaned.
      if (run.status === "awaiting") {
        preservedParked += 1;
        continue;
      }
      // A run with no deployment can never have a routable supervisor, so it
      // is unconditionally orphaned by a restart. A `provisioning` run always
      // has a null deployment, so it falls straight through to the fail below.
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
        // Mark the genuinely-interrupted run terminal. The failure REASON is no
        // longer persisted (the log is the source of truth for run detail,
        // CL-2669); the coarse `failed` status is the index signal.
        await setRunStatus(deps.db, run.id, "failed");
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
      // Per-run deployment (CL-2582): a run's deployment id lives on its
      // `workflow_run_record`, NOT on `workflow_run` — a per-run deploy writes no
      // registry row. So re-establish supervisors by walking the NON-TERMINAL
      // records (the parked runs that must resume after a restart), not the
      // registry. The registry rows supply only the DEPLOY principal:
      // `ensureDeploymentRoutable` revives the supervisor's agent/instance rows
      // as that principal, but the record's `principalId` is the run OWNER, so we
      // recover the deployer from the kind's registry row (keyed by kind+tenant).
      //
      // A run whose record is terminal is never re-established (it needs no live
      // supervisor — that was the staging restart-loop resurrection vector). A
      // kind that has never run, or whose runs are all terminal, re-establishes
      // nothing — a new run self-provisions its own deployment at start.
      const registryRows = await deps.db
        .select({
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
      const deployPrincipalByKind = new Map<string, string>();
      for (const r of registryRows) {
        deployPrincipalByKind.set(`${r.kind} ${r.tenantId}`, r.principalId);
      }

      const activeRecords = await deps.db
        .select({
          deploymentId: workflowRunRecord.deploymentId,
          kind: workflowRunRecord.kind,
          tenantId: workflowRunRecord.tenantId,
        })
        .from(workflowRunRecord)
        .where(
          and(
            inArray(workflowRunRecord.status, ["running", "awaiting"]),
            isNotNull(workflowRunRecord.deploymentId),
            isNull(workflowRunRecord.deletedAt),
          ),
        );

      const seen = new Set<string>();
      let reestablished = 0;
      let skippedNoPrincipal = 0;
      for (const rec of activeRecords) {
        if (rec.deploymentId === null || seen.has(rec.deploymentId)) continue;
        seen.add(rec.deploymentId);
        const deployPrincipal = deployPrincipalByKind.get(
          `${rec.kind} ${rec.tenantId}`,
        );
        if (deployPrincipal === undefined) {
          // The kind was undeployed since the run started — no registry row to
          // recover the deploy principal from, so the supervisor can't be
          // revived. Leave it (the run can't resume against a gone definition).
          skippedNoPrincipal += 1;
          continue;
        }
        try {
          const result = await deps.ensureDeploymentRoutable({
            deploymentId: rec.deploymentId,
            kind: rec.kind,
            tenantId: rec.tenantId,
            creatorPrincipalId: deployPrincipal,
          });
          if (result.reestablished) reestablished += 1;
        } catch (err) {
          log.warn("workflow reconcile: re-establish failed for deployment", {
            deploymentId: rec.deploymentId,
            kind: rec.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (reestablished > 0 || skippedNoPrincipal > 0) {
        log.info("workflow reconcile pass complete", {
          activeRecords: activeRecords.length,
          reestablished,
          skippedNoPrincipal,
        });
      }
    } finally {
      reconciling = false;
    }
  }

  async function reclaimOrphanedDeployments(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_RECLAIM_WINDOW_MS);
    const recentTerminal = await deps.db
      .select({
        deploymentId: workflowRunRecord.deploymentId,
        tenantId: workflowRunRecord.tenantId,
      })
      .from(workflowRunRecord)
      .where(
        and(
          inArray(workflowRunRecord.status, ["completed", "failed"]),
          isNotNull(workflowRunRecord.deploymentId),
          // Soft-deleted (archived) terminal runs are INCLUDED: an archive whose
          // immediate teardown failed still has a live deployment that must be
          // reclaimed (CL-2629). The per-deploymentId liveness LIKE below gates
          // exactly what gets torn down, so seeing archived rows is safe.
          gt(workflowRunRecord.updatedAt, cutoff),
        ),
      );

    const seen = new Set<string>();
    let reclaimed = 0;
    for (const rec of recentTerminal) {
      if (rec.deploymentId === null || seen.has(rec.deploymentId)) continue;
      seen.add(rec.deploymentId);
      // Scoped, per-deploymentId liveness check — a LIKE on this exact
      // deploymentId's instance prefix, never a broad `ins_ses_%` sweep, so it
      // can only ever match THIS workflow deployment's supervisor/step rows
      // (no risk of touching a non-workflow agent's instances). A terminal run
      // whose teardown already fired has no live rows → skipped.
      const live = await deps.db
        .select({ id: intxSchema.agentInstance.id })
        .from(intxSchema.agentInstance)
        .where(
          and(
            like(intxSchema.agentInstance.address, `ins_${rec.deploymentId}%`),
            isNull(intxSchema.agentInstance.endedAt),
          ),
        )
        .limit(1);
      if (live.length === 0) continue;
      try {
        await deps.reclaimDeployment({
          deploymentId: rec.deploymentId,
          tenantId: rec.tenantId,
          reason: "terminal run deployment reclaimed by janitor (CL-2582)",
        });
        reclaimed += 1;
      } catch (err) {
        log.warn("orphan reclaim failed for deployment", {
          deploymentId: rec.deploymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (reclaimed > 0) {
      log.info("reclaimed orphaned terminal deployments", { reclaimed });
    }
  }

  return {
    failOrphanedRuns,
    reconcileAll,
    reclaimOrphanedDeployments,
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
