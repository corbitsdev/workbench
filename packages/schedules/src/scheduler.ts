// The ticking runtime: on a fixed interval, finds every enabled
// schedule due to fire, launches each through `ScheduleLauncher`, and
// advances its `nextRunAt`. Ticks are non-overlapping and coalesced —
// a tick still running when the next one is due is skipped outright
// (never queued), since a due-computation re-run before the prior one
// settles would otherwise double-launch. A single schedule's launch
// failure never aborts the tick or silently drops the schedule: it is
// logged loud (schedule id and the underlying error) and the schedule's
// `nextRunAt` still advances, so a persistently broken definition fails
// loudly forever rather than either wedging the whole tick or spinning
// a tight retry loop against a target that will never succeed.
import type { getLogger } from "@intx/log";
import type { ScheduleLauncher } from "./launcher";
import type { ScheduleRow, ScheduleStore } from "./store";
import { computeNextRun } from "./trigger";

/** `@intx/log` re-exports `@logtape/logtape`'s `getLogger` but not its `Logger` type by name; derived here rather than widening that package's surface for one type alias. */
export type ScheduleLogger = ReturnType<typeof getLogger>;

export type CreateSchedulerDeps = {
  store: ScheduleStore;
  launcher: ScheduleLauncher;
  log: ScheduleLogger;
  /** How often to check for due schedules. */
  tickIntervalMs: number;
  /** Injectable clock, so tests control "now" without real timers. */
  now?: () => Date;
};

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Runs one tick immediately, awaiting its completion — the seam tests drive instead of waiting on the interval timer. */
  tickOnce(): Promise<void>;
}

export function createScheduler(deps: CreateSchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function runDueSchedule(row: ScheduleRow): Promise<void> {
    const firedAt = now();
    try {
      await deps.launcher.launchScheduledRun({
        tenantId: row.tenantId,
        scheduleId: row.id,
        workflowDefinitionId: row.workflowDefinitionId,
        createdBy: row.createdBy,
        input: row.input,
      });
    } catch (error) {
      deps.log.error`schedule ${row.id} failed to launch: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    await deps.store.recordRun({
      id: row.id,
      lastRunAt: firedAt,
      nextRunAt: computeNextRun(row.trigger, firedAt),
    });
  }

  async function tick(): Promise<void> {
    if (ticking) {
      deps.log.warn`schedule tick skipped: the prior tick is still running`;
      return;
    }
    ticking = true;
    try {
      const due = await deps.store.findDue(now());
      for (const row of due) {
        await runDueSchedule(row);
      }
    } catch (error) {
      deps.log.error`schedule tick failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void tick(), deps.tickIntervalMs);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    tickOnce: tick,
  };
}
