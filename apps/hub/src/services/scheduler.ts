import { getLogger } from "@intx/log";

const log = getLogger(["services", "scheduler"]);

const MS_PER_MINUTE = 60_000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;

/** The recurrence window index a clock read falls into: how many
 * `intervalMinutes`-sized windows have elapsed since the `anchorMinuteUtc`
 * phase, floored. Exported so callers (the tick loop, the mark-fired write)
 * derive the same index from the same clock read. */
export function windowIndexFor(
  nowMs: number,
  intervalMinutes: number,
  anchorMinuteUtc: number,
): number {
  const nowMinuteUtc = Math.floor(nowMs / MS_PER_MINUTE);
  return Math.floor((nowMinuteUtc - anchorMinuteUtc) / intervalMinutes);
}

// One durable schedule the tick evaluates. `lastFiredWindowIndex` is the
// integer recurrence-window index (see `windowIndexFor`) the schedule last
// fired in — NOT NULL by construction. There is no "never fired" state
// distinct from "fired in some window": every write path (creation,
// retargeting, and migration 0080's backfill for legacy never-fired rows)
// stamps a real window index, because a NULL/absent value here is
// indistinguishable at read time from "overdue since the beginning of
// time" under the catch-up rule below — that ambiguity is what caused a
// migrated never-fired row to fire immediately on deploy before the
// backfill was fixed. The scheduler stays generic otherwise — it delivers
// `triggerPayload` verbatim and knows nothing about heartbeat specifics.
export interface ScheduledTriggerRow {
  id: string;
  tenantId: string;
  workflowKind: string;
  intervalMinutes: number;
  anchorMinuteUtc: number;
  lastFiredWindowIndex: number;
  ownerMemberPrincipalId: string;
  triggerPayload: Record<string, unknown>;
}

export type StartWorkflowRunFn = (a: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
  triggerPayload: Record<string, unknown>;
  // The firing tick's clock read and this row's fire state, passed through so
  // the caller can derive a fire-time value (e.g. a heartbeat's
  // `createdAfter`) without re-reading the schedule row itself.
  nowMs: number;
  lastFiredWindowIndex: number;
  intervalMinutes: number;
  anchorMinuteUtc: number;
}) => Promise<{ deploymentId: string; accepted: boolean; runId: string }>;

// Pure decision: fire when the current recurrence window index is GREATER
// THAN the window this schedule last fired in. No clock read — the caller
// passes `nowMs` so the decision is deterministic and unit-testable.
//
// This is deliberately a catch-up rule, not an exact-boundary-minute match.
// An earlier version required `nowMinuteUtc` to land exactly on the window
// boundary, which is unsafe against this scheduler's own reentrancy guard:
// `createScheduler`'s tick loop drops (does not defer) an overlapping tick,
// and a slow `listSchedules` call, a GC pause, or the SIGTERM drain every
// staging deploy triggers can eat exactly the one tick that would have
// matched a 5-minute routine's boundary minute — silently skipping that
// occurrence with nothing to distinguish "not due yet" from "missed". `>`
// instead of exact-match tolerates a late or skipped tick (a boundary
// crossed with no tick landing on it still fires on the very next tick that
// runs) while still being double-fire-safe: after firing, `markFired`
// persists the CURRENT window index, so the same window can never satisfy
// `windowIndex > lastFiredWindowIndex` again.
//
// The problem this previously guarded against — a never-fired schedule
// created mid-window firing immediately instead of waiting for its actual
// target time — is solved by construction: `lastFiredWindowIndex` is never
// null (see `ScheduledTriggerRow`). Every write path that sets a schedule's
// recurrence (createOwnerSchedule, ensureOwnerSchedule, updateOwnerSchedule,
// updateTenantScopedSchedule) — and the migration backfill for legacy
// never-fired rows — stamps `lastFiredWindowIndex` to the window index
// current AT THAT MOMENT, so a fresh or retargeted schedule cannot fire
// until the NEXT window opens. There is deliberately no `?? -Infinity`
// fallback here: a NULL would be structurally ambiguous ("never fired" vs.
// "overdue since epoch"), so the column is NOT NULL and this function takes
// a plain `number` — the ambiguity is impossible to construct, not just
// handled.
export function shouldFire(
  nowMs: number,
  lastFiredWindowIndex: number,
  intervalMinutes: number,
  anchorMinuteUtc: number,
): boolean {
  const windowIndex = windowIndexFor(nowMs, intervalMinutes, anchorMinuteUtc);
  return windowIndex > lastFiredWindowIndex;
}

export interface SchedulerDeps {
  // Per-tenant feature-grant check (env override OR owner grant), re-evaluated
  // every tick so a live owner toggle takes effect without a restart.
  isTenantEnabled: (tenantId: string) => Promise<boolean>;
  // Enabled schedules to evaluate this tick. Injected so `shouldFire` never
  // queries; a durable store reads the DB, a test supplies fixtures.
  listSchedules: () => Promise<ScheduledTriggerRow[]>;
  // Persist that a schedule fired in `windowIndex`. Called BEFORE the
  // run-start await so a slow start (or a process restart) cannot double-fire.
  markFired: (id: string, windowIndex: number) => Promise<void>;
  /** Persist schedule → run linkage after a successful start (CL-3526). */
  recordRunStarted?: (args: {
    scheduleId: string;
    tenantId: string;
    runId: string;
  }) => Promise<void>;
  startWorkflowRun: StartWorkflowRunFn;
  now?: () => number;
  tickIntervalMs?: number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  // Exposed for tests; the interval calls this with the tick's single clock
  // read.
  tick(nowMs: number): Promise<void>;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Coalesce overlapping ticks: setInterval does not await the async callback,
  // so a slow tick must not run concurrently with the next — that is how the
  // same schedule would fire twice before its marker is persisted.
  let running = false;

  async function fireRow(
    row: ScheduledTriggerRow,
    windowIndex: number,
    nowMs: number,
  ) {
    try {
      await deps.markFired(row.id, windowIndex);
    } catch (err) {
      // No durable marker → no fire: firing anyway would risk an unbounded
      // re-fire loop. Surface and skip this row; the next tick retries.
      log.error("scheduler: mark-fired failed", {
        scheduleId: row.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    try {
      const started = await deps.startWorkflowRun({
        kind: row.workflowKind,
        tenantId: row.tenantId,
        creatorPrincipalId: row.ownerMemberPrincipalId,
        triggerPayload: row.triggerPayload,
        nowMs,
        lastFiredWindowIndex: row.lastFiredWindowIndex,
        intervalMinutes: row.intervalMinutes,
        anchorMinuteUtc: row.anchorMinuteUtc,
      });
      if (deps.recordRunStarted) {
        try {
          await deps.recordRunStarted({
            scheduleId: row.id,
            tenantId: row.tenantId,
            runId: started.runId,
          });
        } catch (err) {
          log.error("scheduler: record-run-started failed", {
            scheduleId: row.id,
            runId: started.runId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    } catch (err) {
      // CL-4586: the fired-marker is NOT rolled back here, deliberately. A
      // schedule can be permanently unstartable (its recipients were deleted,
      // so every fire's enrichment throws); re-arming the window would retry
      // it on every tick forever — a storm of failed runs and inbox notices
      // for a fault only the owner can fix. Instead the failure is recorded
      // AGAINST that window by `recordPreStartFailure` in the run starter: a
      // terminal failed run row plus the standard terminal-failure mail. So
      // the fire is visible and the attempt budget stays exactly one per
      // recurrence window, failure or not.
      log.error("scheduler: run-start failed", {
        scheduleId: row.id,
        ownerMemberPrincipalId: row.ownerMemberPrincipalId,
        workflowKind: row.workflowKind,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function tick(nowMs: number): Promise<void> {
    let rows: ScheduledTriggerRow[];
    try {
      rows = await deps.listSchedules();
    } catch (err) {
      log.error("scheduler: enumerate failed", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    for (const row of rows) {
      if (
        !shouldFire(
          nowMs,
          row.lastFiredWindowIndex,
          row.intervalMinutes,
          row.anchorMinuteUtc,
        )
      ) {
        continue;
      }
      const enabled = await deps.isTenantEnabled(row.tenantId);
      if (!enabled) continue;
      const windowIndex = windowIndexFor(
        nowMs,
        row.intervalMinutes,
        row.anchorMinuteUtc,
      );
      // A single row's failure is logged inside fireRow and never aborts the
      // batch — one member's schedule never blocks another's.
      await fireRow(row, windowIndex, nowMs);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void tick(now())
          .catch((err) =>
            log.error("scheduler: tick failed", {
              error: err instanceof Error ? err : new Error(String(err)),
            }),
          )
          .finally(() => {
            running = false;
          });
      }, tickIntervalMs);
      // Never hold the process open in Railway's SIGTERM -> SIGKILL window.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
