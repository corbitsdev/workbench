import { getLogger } from "@intx/log";

const log = getLogger(["services", "scheduler"]);

const MS_PER_DAY = 86_400_000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;

// One durable schedule the tick evaluates. `lastFiredDayUtc` is the integer UTC
// day index (floor(ms / 86_400_000)) the schedule last fired on, or null if it
// never has. The scheduler stays generic — it delivers `triggerPayload`
// verbatim and knows nothing about heartbeat specifics.
export interface ScheduledTriggerRow {
  id: string;
  tenantId: string;
  workflowKind: string;
  hourUtc: number;
  lastFiredDayUtc: number | null;
  ownerMemberPrincipalId: string;
  triggerPayload: Record<string, unknown>;
}

export type StartWorkflowRunFn = (a: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
  triggerPayload: Record<string, unknown>;
}) => Promise<{ deploymentId: string; accepted: boolean }>;

// Pure decision: fire when we are in the target UTC hour and this schedule has
// not already fired today. No clock read — the caller passes `nowMs` so the
// decision is deterministic and unit-testable.
export function shouldFire(
  nowMs: number,
  lastFiredDayUtc: number | null,
  hourUtc: number,
): boolean {
  const now = new Date(nowMs);
  if (now.getUTCHours() !== hourUtc) return false;
  const today = Math.floor(nowMs / MS_PER_DAY);
  return lastFiredDayUtc !== today;
}

export interface SchedulerDeps {
  // Static, deployment-wide fallback used when `isTenantEnabled` is not
  // provided (kept for tests and any caller that has not migrated to the
  // per-tenant feature grant). Ignored once `isTenantEnabled` is set.
  enabled: boolean;
  // Per-tenant feature-grant check (env override OR owner grant), re-evaluated
  // every tick so a live owner toggle takes effect without a restart. Optional
  // for back-compat; when absent, `enabled` gates every row uniformly.
  isTenantEnabled?: (tenantId: string) => Promise<boolean>;
  // Enabled schedules to evaluate this tick. Injected so `shouldFire` never
  // queries; a durable store reads the DB, a test supplies fixtures.
  listSchedules: () => Promise<ScheduledTriggerRow[]>;
  // Persist that a schedule fired on `dayUtc`. Called BEFORE the run-start
  // await so a slow start (or a process restart) cannot double-fire.
  markFired: (id: string, dayUtc: number) => Promise<void>;
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

  async function fireRow(row: ScheduledTriggerRow, dayUtc: number) {
    try {
      await deps.markFired(row.id, dayUtc);
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
      await deps.startWorkflowRun({
        kind: row.workflowKind,
        tenantId: row.tenantId,
        creatorPrincipalId: row.ownerMemberPrincipalId,
        triggerPayload: row.triggerPayload,
      });
    } catch (err) {
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
    const today = Math.floor(nowMs / MS_PER_DAY);
    for (const row of rows) {
      if (!shouldFire(nowMs, row.lastFiredDayUtc, row.hourUtc)) continue;
      const enabled = deps.isTenantEnabled
        ? await deps.isTenantEnabled(row.tenantId)
        : deps.enabled;
      if (!enabled) continue;
      // A single row's failure is logged inside fireRow and never aborts the
      // batch — one member's schedule never blocks another's.
      await fireRow(row, today);
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
