// A minimal periodic loop that fires due routines — the one piece
// `@corbits/routines` deliberately does not own (it exposes
// `fireScheduledRoutine` for exactly this, but ships no scheduler: see
// that package's routes.ts doc comment). This mirrors
// `@corbits/agent-lifecycle`'s own `setInterval` sweep (the only other
// periodic loop in this repo) rather than pulling in a new dependency.
//
// Two guarantees, precisely stated:
//
// - Exactly-once against a *concurrent claim*: `RoutineStore.claimRoutineFire`
//   is a conditional update (`nextFireAt <= now` in its WHERE clause,
//   advanced to the trigger's next occurrence in its SET) — a second
//   hub replica racing the same fire loses, because the winner already
//   moved `nextFireAt` into the future before either replica launches
//   anything.
// - At-least-once against a *launch failure*: a claim that wins but
//   whose `fireScheduledRoutine` call then throws is compensated —
//   `nextFireAt` is restored to the moment it was claimed for, so the
//   next poll sees the fire as due again instead of silently skipping
//   it until the trigger's following occurrence.
//
// And missed fires survive a restart: `nextFireAt` is persisted, so
// "due" means `nextFireAt <= now`, not "does the current wall-clock
// minute match" — a fire that was due while the hub was down is still
// due (and gets caught up) the next time this loop polls, exactly like
// `@corbits/schedules` before it.
import type { RoutineLauncher, RoutineStore } from "@corbits/routines";
import { fireScheduledRoutine } from "@corbits/routines";
import { getLogger } from "@intx/log";

export type RoutineSchedulerDeps = {
  store: RoutineStore;
  launcher: RoutineLauncher;
  /** Injectable for deterministic tests; defaults to `Date.now`-backed wall time. */
  now?: () => Date;
};

const POLL_INTERVAL_MS = 30_000;
const log = getLogger(["hub", "routine-scheduler"]);

/**
 * One poll: claim and fire every routine due at `at`. Exported (rather
 * than kept as a closure inside `createRoutineScheduler`) so a test can
 * drive a single, deterministic poll against an injected clock without
 * waiting on `setInterval`.
 */
export async function tickRoutineScheduler(
  deps: Pick<RoutineSchedulerDeps, "store" | "launcher">,
  at: Date,
): Promise<void> {
  const dueRoutines = await deps.store.listDueRoutines(at);
  for (const candidate of dueRoutines) {
    const claimed = await deps.store.claimRoutineFire(candidate.id, at);
    // `undefined` means another replica already claimed this exact
    // fire between `listDueRoutines` and this claim attempt — not an
    // error, just the atomic claim doing its job.
    if (claimed === undefined) continue;
    try {
      await fireScheduledRoutine(
        { store: deps.store, launcher: deps.launcher },
        { tenantId: claimed.tenantId, routine: claimed },
      );
    } catch (err) {
      log.error`scheduled fire of routine ${claimed.id} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      // The claim already advanced `nextFireAt` past `at`; since the
      // launch never happened, restore it to `at` so the next poll
      // retries this fire instead of silently dropping it until the
      // trigger's following occurrence.
      try {
        await deps.store.compensateFailedFire(claimed.id, at);
      } catch (compensateErr) {
        log.error`compensating routine ${claimed.id}'s failed fire also failed: ${
          compensateErr instanceof Error
            ? compensateErr.message
            : String(compensateErr)
        }`;
      }
    }
  }
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickRoutineScheduler(deps, now());
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
