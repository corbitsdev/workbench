import { and, eq, isNull, lt } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";

const log = getLogger(["services", "stalled-scheduled-run-reconciler"]);

// How long a scheduler-fired run may sit parked at an awaitSignal gate before it
// is failed. A scheduled run has no human to answer a gate: its one `intake` gate
// is auto-delivered within seconds (CL-3509), so a run still `awaiting` this long
// after its last log advance means the auto-delivery never landed (an invalid
// stored intake, or an unexpected downstream gate). Generous enough to clear a
// slow re-delivery + park, short enough that a wedged scheduled run does not
// linger in the Now feed indefinitely.
export const DEFAULT_STALLED_SCHEDULED_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export const DEFAULT_STALLED_SCHEDULED_RUN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Fail scheduler-sourced runs parked at an awaitSignal gate past the timeout.
// STRICTLY scoped to `triggerSource = 'scheduler'` runs: an interactive run
// legitimately waits on a human indefinitely and is never touched here. Marks the
// coarse `failed` status (the log stays the source of truth for detail), so a
// wedged scheduled run fails legibly instead of lingering `awaiting` forever.
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
