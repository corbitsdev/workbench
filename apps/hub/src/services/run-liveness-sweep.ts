import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { getLogger } from "@intx/log";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRunRecord, workflowRunStep } from "../db/schema";
import { failRunIfStillRunning } from "../workflow-executor/run-store";

const log = getLogger(["services", "run-liveness-sweep"]);

// CL-2727: continuous hub-side liveness sweep for workflow runs.
//
// The projection bridge advances a run's status only when a pack ARRIVES. If a
// run's supervisor dies mid-step (sidecar crash, child OOM, lost pack) no
// terminal event is ever committed, so the run's index row sits at `running`
// forever and the UI shows a permanent "in progress". `failOrphanedRuns` catches
// this ONCE at hub boot; a run that dies while the hub stays up is never swept.
// This sweep runs on an interval for the hub's whole lifetime and marks such
// runs failed.
//
// SAFETY — the one hard requirement is to NEVER fail a live run. A healthy run
// can legitimately make no progress for a long time (a slow first step: a large
// LLM/tool call that emits no early pack, or cold provisioning under load). The
// predicate is deliberately asymmetric so that case is left alone:
//
//   1. Only `running` rows are candidates. A run parked at an awaitSignal gate
//      (`awaiting`) is resumable across a restart and is NEVER swept — the query
//      excludes it and the write is a compare-and-set on `status = 'running'`
//      (the CL-2575 invariant, made structural).
//   2. Supervisor GONE (not in the routable set) + idle past `stallGraceMs` →
//      fail. A dead sidecar/child is genuinely orphaned; no pack will ever come.
//   3. Supervisor ROUTABLE + made progress (a folded RunStarted or a projected
//      step) → LEAVE ALONE. A live supervisor mid-step is exactly a healthy
//      long-running run.
//   4. Supervisor ROUTABLE + NO progress → LEAVE ALONE until idle past the far
//      longer `startHardDeadlineMs`. This is the key false-positive fix: a
//      legitimately slow FIRST step keeps a routable supervisor while emitting
//      no pack, so it must NOT be failed on the short grace. Only a run that is
//      routable yet has emitted nothing for the hard deadline (a genuine
//      never-starts hang) is failed, making that hang legible instead of
//      infinite.
//   5. The write is `failRunIfStillRunning` (CAS): if the run moved to
//      `awaiting`/`completed`/`failed` between the scan and the write it matches
//      zero rows. As an extra guard against racing a just-arrived first pack,
//      the sweep RE-CHECKS progress immediately before the CAS and skips the
//      fail if a `startedAt` or step row appeared during the pass — so a run
//      that started mid-sweep is spared even though the CAS predicate would
//      still match `running`. (`applyRunProjection` will overwrite this
//      best-effort terminal write on the next pack anyway — that unconditional
//      overwrite is the intentional self-heal path — but sparing it here avoids
//      a visible flap.)
export interface RunLivenessSweep {
  // Run one pass. Returns the scan/fail counts (for logging + tests).
  sweepOnce(): Promise<{ scanned: number; failed: number }>;
  // Start the interval loop; returns an unsubscribe/clear handle.
  start(): () => void;
}

// Generous single-default fallbacks; the real values are env-validated config
// (apps/hub/src/config.ts) and wired at the construction site. Kept here only so
// the tests and any direct constructor caller have a sane default.
const DEFAULT_STALL_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_START_HARD_DEADLINE_MS = 20 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

export function createRunLivenessSweep(deps: {
  db: HubDb;
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  deploymentDomain: string;
  intervalMs?: number;
  stallGraceMs?: number;
  startHardDeadlineMs?: number;
}): RunLivenessSweep {
  const stallGraceMs = deps.stallGraceMs ?? DEFAULT_STALL_GRACE_MS;
  const startHardDeadlineMs =
    deps.startHardDeadlineMs ?? DEFAULT_START_HARD_DEADLINE_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let sweeping = false;

  // True if the run has made ANY progress: a folded RunStarted (`startedAt`) or
  // at least one projected step (a StepStarted). Read live so it reflects a pack
  // that may have arrived after the candidate scan.
  async function runMadeProgress(runId: string): Promise<boolean> {
    const rec = await deps.db
      .select({ startedAt: workflowRunRecord.startedAt })
      .from(workflowRunRecord)
      .where(eq(workflowRunRecord.id, runId))
      .limit(1);
    if (rec[0]?.startedAt != null) return true;
    const step = await deps.db
      .select({ runId: workflowRunStep.runId })
      .from(workflowRunStep)
      .where(eq(workflowRunStep.runId, runId))
      .limit(1);
    return step.length > 0;
  }

  async function sweepOnce(): Promise<{ scanned: number; failed: number }> {
    if (sweeping) return { scanned: 0, failed: 0 };
    sweeping = true;
    try {
      const routable = new Set(deps.getRoutableAddresses());
      // Scan with the SHORTER grace as the cutoff so both the GONE-past-grace
      // and the routable-past-hard-deadline candidates are fetched; the per-run
      // predicate below applies the correct threshold to each.
      const cutoff = new Date(Date.now() - stallGraceMs);

      const candidates = await deps.db
        .select({
          id: workflowRunRecord.id,
          deploymentId: workflowRunRecord.deploymentId,
          startedAt: workflowRunRecord.startedAt,
          updatedAt: workflowRunRecord.updatedAt,
        })
        .from(workflowRunRecord)
        .where(
          and(
            // Only `running` — never `awaiting` (CL-2575). Structural, not a
            // post-filter: an awaiting run is never even considered here.
            inArray(workflowRunRecord.status, ["running"]),
            isNull(workflowRunRecord.deletedAt),
            lt(workflowRunRecord.updatedAt, cutoff),
          ),
        );

      if (candidates.length === 0) return { scanned: 0, failed: 0 };

      // Which candidates have made ANY progress — a projected step row means the
      // supervisor emitted at least a StepStarted. Combined with the folded
      // `startedAt` (RunStarted), this distinguishes a run-start hang (no
      // progress at all) from a run that began and is mid-step.
      const stepRows = await deps.db
        .select({ runId: workflowRunStep.runId })
        .from(workflowRunStep)
        .where(
          inArray(
            workflowRunStep.runId,
            candidates.map((r) => r.id),
          ),
        );
      const runsWithSteps = new Set(stepRows.map((r) => r.runId));

      let failed = 0;
      const now = Date.now();
      for (const run of candidates) {
        const supervisorAddress =
          run.deploymentId === null
            ? null
            : deriveDeploymentAddress({
                deploymentId: run.deploymentId,
                deploymentDomain: deps.deploymentDomain,
              });
        const supervisorRoutable =
          supervisorAddress !== null && routable.has(supervisorAddress);
        const madeProgress =
          run.startedAt !== null || runsWithSteps.has(run.id);
        const idleMs = now - run.updatedAt.getTime();

        if (supervisorRoutable) {
          // A routable supervisor that has begun is a healthy long-running step
          // — never touch it. A routable supervisor that has emitted NOTHING is
          // only failed once it has hung past the far longer hard deadline; a
          // slow first step under the deadline is left alone. This is the fix:
          // a routable run under the hard deadline is never failed.
          if (madeProgress) continue;
          if (idleMs < startHardDeadlineMs) continue;
        }
        // else: supervisor GONE — a dead sidecar/child. Idle past the grace
        // (guaranteed by the scan cutoff) means it is genuinely orphaned; fail
        // regardless of whether it had begun (a supervisor that died mid-step is
        // exactly the orphan this sweep exists to catch).

        try {
          // Re-check progress immediately before the CAS — but ONLY for a run
          // that had NO progress at scan time. A first pack may have landed
          // during this pass (started the run / wrote a step); if so the run is
          // live now, not wedged, so skip the fail. A run that already had
          // progress at scan is a genuine orphan (GONE mid-step) and must NOT be
          // spared here, so the recheck is gated on `!madeProgress`.
          if (!madeProgress && (await runMadeProgress(run.id))) continue;
          // CAS: fails ONLY if still `running` at write time — never an
          // awaiting/completed/failed run it raced against.
          if (await failRunIfStillRunning(deps.db, run.id, new Date()))
            failed += 1;
        } catch (err) {
          log.warn("run liveness sweep: CAS fail write errored", {
            runId: run.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (failed > 0) {
        log.info("run liveness sweep marked stalled runs failed", {
          scanned: candidates.length,
          failed,
        });
      }
      return { scanned: candidates.length, failed };
    } finally {
      sweeping = false;
    }
  }

  return {
    sweepOnce,
    start() {
      const handle = setInterval(() => {
        void sweepOnce().catch((err) => {
          log.warn("run liveness sweep pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs);
      // Do not keep the process alive for the sweep alone.
      if (typeof handle.unref === "function") handle.unref();
      return () => clearInterval(handle);
    },
  };
}
