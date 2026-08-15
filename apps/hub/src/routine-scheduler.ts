// A minimal periodic loop that fires due routines — the one piece
// `@corbits/routines` deliberately does not own (it exposes
// `fireScheduledRoutine` for exactly this, but ships no scheduler: see
// that package's routes.ts doc comment). This mirrors
// `@corbits/agent-lifecycle`'s own `setInterval` sweep (the only other
// periodic loop in this repo) rather than pulling in a new dependency.
//
// Three guarantees, precisely stated:
//
// - Exactly-once against a *concurrent claim*: `RoutineStore.claimRoutineFire`
//   is a conditional update (enabled, not deleted, not dead-lettered,
//   `nextFireAt <= now` in its WHERE clause, advanced to the trigger's
//   next occurrence in its SET) — a second hub replica racing the same
//   fire loses, because the winner already moved `nextFireAt` into the
//   future before either replica launches anything.
// - At-least-once against a *launch failure*, with exponential backoff:
//   a claim that wins but whose `fireScheduledRoutine` call then throws
//   is marked failed via `markFailedFire` — consecutiveFailures ticks
//   up, `nextFireAt` is set to `failedAt + backoff`, and a
//   `schedule-failed` run is recorded. After
//   `MAX_ROUTINE_FIRE_FAILURES` consecutive failures the routine is
//   dead-lettered (`deadLetteredAt` set, `nextFireAt` null) and the
//   scheduler stops claiming it until an operator re-enables/edits it.
// - Missed fires survive a restart: `nextFireAt` is persisted, so
//   "due" means `nextFireAt <= now`, not "does the current wall-clock
//   minute match" — a fire that was due while the hub was down is still
//   due (and gets caught up) the next time this loop polls.
import type { RoutineLauncher, RoutineStore } from "@corbits/routines";
import { fireScheduledRoutine } from "@corbits/routines";
import { getLogger } from "@intx/log";

export type RoutineSchedulerDeps = {
  store: RoutineStore;
  launcher: RoutineLauncher;
  /** See `@corbits/routines`' `fireScheduledRoutine` — passed straight
   * through so a scheduled fire enforces the same honest
   * channel-required-or-not rule a manual "run now" does. */
  deliveryChannelRequired?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
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
  deps: Pick<
    RoutineSchedulerDeps,
    "store" | "launcher" | "deliveryChannelRequired"
  >,
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
        {
          store: deps.store,
          launcher: deps.launcher,
          ...(deps.deliveryChannelRequired !== undefined
            ? { deliveryChannelRequired: deps.deliveryChannelRequired }
            : {}),
        },
        { tenantId: claimed.tenantId, routine: claimed },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error`scheduled fire of routine ${claimed.id} failed: ${reason}`;
      // The claim already advanced `nextFireAt` past `at`; since the
      // launch never happened, mark the failure with backoff (or
      // dead-letter). `claimed.nextFireAt` is the value the claim
      // itself just wrote (never null — a claim only succeeds for a
      // triggered routine), passed through so the mark is conditional
      // and can't clobber a newer trigger edit.
      try {
        if (claimed.nextFireAt !== null) {
          const result = await deps.store.markFailedFire({
            routineId: claimed.id,
            tenantId: claimed.tenantId,
            claimedNextFireAt: claimed.nextFireAt,
            failedAt: at,
            reason,
          });
          if (result?.deadLettered) {
            log.error`routine ${claimed.id} dead-lettered after ${result.consecutiveFailures} consecutive launch failures`;
          }
        }
      } catch (markErr) {
        log.error`marking routine ${claimed.id}'s failed fire also failed: ${
          markErr instanceof Error ? markErr.message : String(markErr)
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
    } catch (error) {
      log.error`routine scheduler tick failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
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
