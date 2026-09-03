// A routine's health, read off telemetry the scheduler already stores:
// `enabled` / `consecutiveFailures` / `deadLetteredAt` on the routine row
// and the per-fire history rows (`routine_run`). Nothing here needs a new
// column — this module is the reading, not the recording.
//
// It lives in the package, not in the Routines page, because "what counts
// as healthy" is a product rule about routines: the list's state pill, the
// detail page's health rail, and anything else that ever renders a
// routine's condition have to agree, and they can only agree if there is
// one function that decides.

/** The per-fire history row this module reads — structurally the subset of
 * `./client`'s `RoutineRun` that says whether a fire worked and how long
 * it took. Declared here rather than imported so `./client` can re-export
 * this module without a cycle. */
export type RoutineFire = {
  readonly runId: string;
  readonly triggeredBy: string;
  readonly createdAt: string;
  readonly error?: string | null;
  readonly run?: Record<string, unknown>;
};

/** The routine fields health depends on — every one of them already
 * persisted (see ./schema.ts). */
export type RoutineHealthSubject = {
  readonly enabled: boolean;
  readonly consecutiveFailures: number;
  readonly deadLetteredAt: string | null;
};

/**
 * Six states, each its own pill colour and its own words. `paused` is
 * dead-lettered — the scheduler gave up after `MAX_ROUTINE_FIRE_FAILURES`
 * and will not claim the routine again until a person re-enables or edits
 * it — which is a different fact from `off` (someone turned it off) and
 * from `failing` (still scheduled, still retrying).
 */
export type RoutineHealthState =
  "off" | "paused" | "running" | "failing" | "idle" | "ok";

export type RoutineHealth = {
  readonly state: RoutineHealthState;
  /** The pill's words. A pill is never the only signal (DESIGN.md, State
   * Pills) — `caption` says the same thing in a full phrase. */
  readonly label: string;
  readonly caption: string;
  /** Successful fires since the most recent failed one. */
  readonly cleanStreak: number;
  /**
   * When this routine last ran, by the only definition every surface can
   * agree on: the newest row of its own fire history. Deliberately not
   * the routine row's `lastFireAt`, which the store stamps only inside
   * `claimRoutineFire` — a run-now-only routine would report "never run"
   * beside a history table full of runs.
   */
  readonly lastRunAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastFailure: {
    readonly at: string;
    readonly error: string | null;
  } | null;
  /** Median wall-clock duration of the finished fires in `fires` — `null`
   * when none of them recorded both ends. */
  readonly medianDurationMs: number | null;
};

function statusOf(fire: {
  readonly run?: Record<string, unknown>;
}): string | null {
  const status = fire.run?.status;
  return typeof status === "string" ? status : null;
}

/**
 * How long a fire may credibly still be doing work before a lingering
 * `running` status with no `endedAt` is read as an abandoned fire
 * (warm-keep CL-6681 / CL-6778). A routine fire that finished is
 * supposed to land `completed`/`failed`/`cancelled` plus `endedAt` via
 * `markTerminal`; this window is the last-resort reading for a fire
 * that never got that write — never the happy path. Past it, a
 * still-`running` fire with no end stamp is presumed to have already
 * delivered, so every surface badging its status reads it through
 * `fireOutcomeStatus` rather than the raw column.
 */
export const FIRE_RUNNING_WINDOW_MS = 10 * 60 * 1000;

/**
 * A fire's status the way this build should show it: the raw
 * `run.status` for every non-running value; a `running` row that
 * already carries `endedAt` is finished immediately (the persist
 * path); a `running` row with no `endedAt` older than
 * `FIRE_RUNNING_WINDOW_MS` is an abandoned fire read as `completed`.
 * Every caller that needs a fire's displayed status goes through here,
 * never `fire.run?.status` directly.
 */
export function fireOutcomeStatus(
  fire: Pick<RoutineFire, "createdAt"> & {
    readonly run?: Record<string, unknown>;
  },
  now: number,
): string | null {
  const status = statusOf(fire);
  if (status !== "running") return status;
  const endedAt = fire.run?.endedAt;
  if (typeof endedAt === "string" && endedAt !== "") return "completed";
  const startedAt = Date.parse(fire.createdAt);
  if (Number.isNaN(startedAt)) return status;
  return now - startedAt > FIRE_RUNNING_WINDOW_MS ? "completed" : "running";
}

/**
 * `fireOutcomeStatus` for a platform run whose status lives at the top
 * level (`workflow_run.status`), not nested on a routine fire's `run`.
 * Insights, Mission Control, and the shell activity feed all see that
 * shape. `endedAt` is the persist-path signal that the fire already
 * finished; the running-window is only for abandoned fires that never
 * got that stamp.
 */
export function runOutcomeStatus(
  run: {
    readonly createdAt: string;
    readonly status: string;
    readonly endedAt?: string | null;
  },
  now: number,
): string | null {
  return fireOutcomeStatus(
    {
      createdAt: run.createdAt,
      run: { status: run.status, endedAt: run.endedAt },
    },
    now,
  );
}

/** A fire failed when it recorded a launch error (the synthetic
 * `schedule-failed` row) or its run settled as failed. */
export function fireFailed(fire: RoutineFire): boolean {
  if (fire.error !== undefined && fire.error !== null) return true;
  return statusOf(fire) === "failed";
}

function fireSucceeded(fire: RoutineFire, now: number): boolean {
  return !fireFailed(fire) && fireOutcomeStatus(fire, now) === "completed";
}

/** Successful fires from the newest backwards, stopping at the first
 * failure — the "N clean runs" streak, not a lifetime total. */
export function cleanFireStreak(
  fires: readonly RoutineFire[],
  now: number,
): number {
  let streak = 0;
  for (const fire of fires) {
    if (fireFailed(fire)) break;
    if (fireSucceeded(fire, now)) streak += 1;
  }
  return streak;
}

/** The most recent failed fire, or `null` when none of the history failed. */
export function lastFailedFire(
  fires: readonly RoutineFire[],
): { readonly at: string; readonly error: string | null } | null {
  const failed = fires.find(fireFailed);
  if (failed === undefined) return null;
  return { at: failed.createdAt, error: failed.error ?? null };
}

function durationOf(fire: RoutineFire): number | null {
  const endedAt = fire.run?.endedAt;
  if (typeof endedAt !== "string") return null;
  const startedRaw = fire.run?.createdAt;
  const started = Date.parse(
    typeof startedRaw === "string" ? startedRaw : fire.createdAt,
  );
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) return null;
  return ended < started ? null : ended - started;
}

/**
 * Median duration over the fires that recorded both a start and an end.
 * Median, not mean: one run that hung for an hour should not make a
 * routine that normally takes twelve seconds look slow.
 */
export function medianFireDurationMs(
  fires: readonly RoutineFire[],
): number | null {
  const durations = fires
    .map(durationOf)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const middle = Math.floor(durations.length / 2);
  if (durations.length % 2 === 1) return durations[middle] ?? null;
  const lower = durations[middle - 1];
  const upper = durations[middle];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

function pluralRuns(count: number): string {
  return count === 1 ? "1 run" : `${String(count)} runs`;
}

function stateAndWords(
  routine: RoutineHealthSubject,
  fires: readonly RoutineFire[],
  streak: number,
  now: number,
): {
  readonly state: RoutineHealthState;
  readonly label: string;
  readonly caption: string;
} {
  if (!routine.enabled) {
    return {
      state: "off",
      label: "Off",
      caption: "Turned off — it will not run on its schedule.",
    };
  }
  if (routine.deadLetteredAt !== null) {
    return {
      state: "paused",
      label: "Paused after failures",
      caption:
        "Too many failures in a row — paused until someone resumes or edits it.",
    };
  }
  const latest = fires[0];
  if (latest !== undefined && fireOutcomeStatus(latest, now) === "running") {
    return {
      state: "running",
      label: "Running now",
      caption: "A run is in progress.",
    };
  }
  if (routine.consecutiveFailures > 0) {
    return {
      state: "failing",
      label: "Failing",
      caption: `${pluralRuns(routine.consecutiveFailures)} failed in a row — still retrying.`,
    };
  }
  if (latest !== undefined && fireFailed(latest)) {
    return {
      state: "failing",
      label: "Last run failed",
      caption: "The most recent run failed.",
    };
  }
  if (fires.length === 0) {
    return {
      state: "idle",
      label: "Not run yet",
      caption: "This routine has never run.",
    };
  }
  return {
    state: "ok",
    label: "Healthy",
    caption:
      streak === 0
        ? "No failures on record."
        : `${pluralRuns(streak)} in a row without a failure.`,
  };
}

/**
 * A routine's health from its own row plus its fire history (newest
 * first, as `GET /routines/:id/runs` returns it). `now` defaults to the
 * wall clock — callers that render a ticking page pass their own shared
 * clock so this agrees with the rest of that page's relative times.
 */
export function routineHealth(
  routine: RoutineHealthSubject,
  fires: readonly RoutineFire[],
  now: number = Date.now(),
): RoutineHealth {
  const cleanStreak = cleanFireStreak(fires, now);
  const words = stateAndWords(routine, fires, cleanStreak, now);
  return {
    state: words.state,
    label: words.label,
    caption: words.caption,
    cleanStreak,
    lastRunAt: fires[0]?.createdAt ?? null,
    consecutiveFailures: routine.consecutiveFailures,
    lastFailure: lastFailedFire(fires),
    medianDurationMs: medianFireDurationMs(fires),
  };
}
