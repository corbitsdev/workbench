import { and, eq, exists, isNull, lt } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRunRecord, workflowRunStep } from "../db/schema";
import {
  failRunIfStillAwaiting,
  listExhaustedFailedRunSteps,
} from "../workflow-executor/run-store";

const log = getLogger(["services", "stalled-scheduled-run-reconciler"]);

// How long a scheduler-fired run may sit parked at an awaitSignal gate before it
// is failed. Scheduled runs have no human in the loop: the `intake` gate is
// auto-delivered within seconds (CL-3509), and allowed multi-gate kinds may then
// sit on post-intake gates while Myra drives them via the scheduled gate agent
// (CL-3528). A run still `awaiting` past this timeout after its last DB touch
// means intake never landed, post-intake drive never completed, or the run is
// stuck on a gate the agent cannot resolve. The window is generous enough for a
// slow Myra turn + queue, short enough that a wedged scheduled run does not
// linger in the Now feed indefinitely.
export const DEFAULT_STALLED_SCHEDULED_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export const DEFAULT_STALLED_SCHEDULED_RUN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Fail scheduler-sourced runs parked at an awaitSignal gate past the timeout.
// STRICTLY scoped to `triggerSource = 'scheduler'` runs: an interactive run
// legitimately waits on a human indefinitely and is never touched here. This
// sweep is the backstop when CL-3528 Myra gate-drive or CL-3509 intake delivery
// does not clear the gate in time — it only flips coarse `failed` on the run row
// (the workflow log stays the source of truth for detail).
// Returns the number of runs failed. Best-effort per row — one failure is logged
// and never aborts the batch.
export async function failStalledScheduledRuns(
  db: HubDb,
  opts?: { timeoutMs?: number; now?: () => number },
): Promise<number> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_STALLED_SCHEDULED_RUN_TIMEOUT_MS;
  const nowMs = (opts?.now ?? Date.now)();
  const cutoff = new Date(nowMs - timeoutMs);

  const stalled = await db
    .select({ id: workflowRunRecord.id, kind: workflowRunRecord.kind })
    .from(workflowRunRecord)
    .where(
      and(
        eq(workflowRunRecord.status, "awaiting"),
        eq(workflowRunRecord.triggerSource, "scheduler"),
        isNull(workflowRunRecord.deletedAt),
        lt(workflowRunRecord.updatedAt, cutoff),
      ),
    );

  let failed = 0;
  for (const run of stalled) {
    try {
      await db
        .update(workflowRunRecord)
        .set({ status: "failed" })
        .where(
          and(
            eq(workflowRunRecord.id, run.id),
            eq(workflowRunRecord.status, "awaiting"),
          ),
        );
      failed += 1;
    } catch (err) {
      log.warn("failStalledScheduledRuns: failed to mark run failed", {
        runId: run.id,
        kind: run.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed > 0) {
    log.info("failed stalled scheduled runs parked past timeout", {
      failed,
      timeoutMs,
    });
  }
  return failed;
}

// Fail runs that are DEAD-parked: `awaiting` at a gate while at least one
// sibling step has PERMANENTLY failed (its retry policy exhausted). This is
// the general-purpose counterpart to `failStalledScheduledRuns` above — it
// applies to EVERY run, not only scheduler-fired ones, and fires immediately
// (no timeout window) because the state is unambiguous the moment it is
// observed.
//
// Root cause (CL-3509 follow-up): `@intx/workflow`'s `areDepsResolved` only
// checks that a dependency is TERMINAL, and `failed` is terminal — so a step
// downstream of a permanently-failed dependency is scheduled anyway. When
// that dependent is an `awaitSignal` gate, it parks; the run's own "am I
// done" check requires every step terminal, and a parked gate never reaches
// one, so the run sits `awaiting` forever alongside its dead step. Nothing a
// human supplies to that gate can revive the run — the failed dependency's
// output will never exist — so this is settled as `failed` immediately, not
// after a timeout.
//
// IMPORTANT — this join is NOT dependency-aware: it does not verify the
// parked gate is actually downstream of the exhausted-failed step, only that
// BOTH exist somewhere in the same run (two independent DAG branches is a
// supported pattern). It is intentionally conservative in the direction that
// matters: `retries_exhausted = true` is a genuinely terminal fact for that
// step (no future event can ever move it again — see the column comment), so
// once true, that step contributes nothing further to the run's eventual
// completion; a HUMAN parked on any independent gate in the same run cannot
// unstick it either, because the run's own completion requires every step
// (including the dead one) to reach terminal, which the dead step never will
// on its own. A precise dependency check (b) would be a strictly tighter
// version of this rule, not a different one — worth doing as a follow-up, not
// required for correctness here.
//
// STRICTLY requires `retries_exhausted = true` on the failed step — `phase =
// 'failed'` ALONE is a re-entrancy marker the runtime revisits between retry
// attempts (see `workflowRunStep.retriesExhausted` column comment), not a
// terminal verdict. A step still backing off before a retry that would have
// succeeded must NEVER trigger this sweep. And a run legitimately parked at a
// gate with no failed step at all is never touched (the same condition a
// human is correctly waiting on indefinitely).
//
// CAS'd via `failRunIfStillAwaiting` (the same primitive the operator abort
// path shares), so a run that has since cleared the gate on its own between
// the read and the write is left alone — idempotent and safe to run on every
// tick.
// Returns the number of runs failed. Best-effort per row.
export async function failDeadParkedRuns(db: HubDb): Promise<number> {
  const parked = await db
    .select({ id: workflowRunRecord.id, kind: workflowRunRecord.kind })
    .from(workflowRunRecord)
    .where(
      and(
        eq(workflowRunRecord.status, "awaiting"),
        isNull(workflowRunRecord.deletedAt),
        exists(
          db
            .select({ one: workflowRunStep.id })
            .from(workflowRunStep)
            .where(
              and(
                eq(workflowRunStep.runId, workflowRunRecord.id),
                eq(workflowRunStep.phase, "failed"),
                eq(workflowRunStep.retriesExhausted, true),
              ),
            ),
        ),
      ),
    );

  let failed = 0;
  for (const run of parked) {
    try {
      const flipped = await failRunIfStillAwaiting(db, run.id);
      if (!flipped) continue;
      const failedSteps = await listExhaustedFailedRunSteps(db, run.id);
      log.error("dead-parked workflow run settled as failed", {
        runId: run.id,
        kind: run.kind,
        failedSteps,
      });
      failed += 1;
    } catch (err) {
      log.warn("failDeadParkedRuns: failed to settle run", {
        runId: run.id,
        kind: run.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}

// Register the periodic health sweep for parked runs. Owns a reentrancy guard
// (a slow sweep must not overlap the next) and returns an unsubscribe that
// clears the timer; the timer is `unref`'d so it never keeps the process
// alive. Runs BOTH sweeps on the same tick/rail: the scheduler-only stalled
// check (timeout-gated) and the general dead-parked-run check (fires
// immediately, every run) — one failing sweep never blocks the other.
export function registerStalledScheduledRunReconciler(deps: {
  db: HubDb;
  timeoutMs?: number;
  intervalMs?: number;
}): () => void {
  const intervalMs =
    deps.intervalMs ?? DEFAULT_STALLED_SCHEDULED_RUN_SWEEP_INTERVAL_MS;
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void Promise.allSettled([
      failStalledScheduledRuns(deps.db, {
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      }).catch((err) => {
        log.error("stalled scheduled run sweep tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }),
      failDeadParkedRuns(deps.db).catch((err) => {
        log.error("dead-parked run sweep tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }),
    ]).finally(() => {
      sweeping = false;
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
