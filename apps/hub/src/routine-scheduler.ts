// A minimal periodic loop that fires due routines — the one piece
// `@corbits/routines` deliberately does not own (it exposes
// `fireScheduledRoutine` for exactly this, but ships no scheduler: see
// that package's routes.ts doc comment). This mirrors
// `@corbits/agent-lifecycle`'s own `setInterval` sweep (the only other
// periodic loop in this repo) rather than pulling in a new dependency: a
// single-process, at-least-once poller, not a distributed cron engine.
//
// `routine`/`routineRun` are `@corbits/routines`' own exported schema
// tables (its public surface, alongside `RoutineStore`) — read directly
// here because `RoutineStore` is deliberately tenant-scoped
// (`listRoutines(tenantId)`; see store.ts) and has no cross-tenant
// enumeration, which a scheduler needs and a per-request route never
// does. This is the same "read the extension's exported schema
// directly" pattern chat's own routes use for `channel_launch`.
import { desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  cronExpressionForTrigger,
  fireScheduledRoutine,
  routine,
  routineRun,
  type RoutineLauncher,
  type RoutineRow,
  type RoutineStore,
} from "@corbits/routines";
import { getLogger } from "@intx/log";
import { cronMatchesMinute, minuteKey } from "./cron-due";

export type RoutineSchedulerDeps = {
  db: DB["db"];
  store: RoutineStore;
  launcher: RoutineLauncher;
  /** Injectable for deterministic tests; defaults to `Date.now`-backed wall time. */
  now?: () => Date;
};

const POLL_INTERVAL_MS = 30_000;
const log = getLogger(["hub", "routine-scheduler"]);

/**
 * Every enabled, timer-triggered routine, each paired with the minute key
 * of its own most recent scheduled fire (`undefined` if it has never
 * fired on a schedule before) — the guard that keeps a routine whose
 * cadence matches for the whole span of a tick from firing twice.
 */
async function loadSchedulableRoutines(
  db: DB["db"],
): Promise<
  readonly { routine: RoutineRow; lastFiredMinute: number | undefined }[]
> {
  const rows = (await db
    .select()
    .from(routine)
    .where(eq(routine.enabled, true))) as RoutineRow[];
  const timerRows = rows.filter((row) => row.trigger !== null);

  const lastFiredByRoutine = new Map<string, number>();
  const scheduledRuns = await db
    .select({
      routineId: routineRun.routineId,
      createdAt: routineRun.createdAt,
    })
    .from(routineRun)
    .where(eq(routineRun.triggeredBy, "schedule"))
    .orderBy(desc(routineRun.createdAt));
  for (const run of scheduledRuns) {
    if (!lastFiredByRoutine.has(run.routineId)) {
      lastFiredByRoutine.set(run.routineId, minuteKey(run.createdAt));
    }
  }

  return timerRows.map((row) => ({
    routine: row,
    lastFiredMinute: lastFiredByRoutine.get(row.id),
  }));
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const at = now();
      const currentMinute = minuteKey(at);
      const candidates = await loadSchedulableRoutines(deps.db);
      for (const { routine: row, lastFiredMinute } of candidates) {
        if (row.trigger === null) continue;
        if (lastFiredMinute === currentMinute) continue;
        const expression = cronExpressionForTrigger(row.trigger);
        if (!cronMatchesMinute(expression, at)) continue;
        try {
          await fireScheduledRoutine(
            { store: deps.store, launcher: deps.launcher },
            { tenantId: row.tenantId, routine: row },
          );
        } catch (err) {
          log.error`scheduled fire of routine ${row.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
