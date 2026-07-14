import { and, eq, isNull, lt } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";

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

// Register the periodic stalled-scheduled-run sweep. Owns a reentrancy guard (a
// slow sweep must not overlap the next) and returns an unsubscribe that clears
// the timer; the timer is `unref`'d so it never keeps the process alive.
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
    void failStalledScheduledRuns(deps.db, {
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    })
      .catch((err) => {
        log.error("stalled scheduled run sweep tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
