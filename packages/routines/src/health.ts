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

/** One turn on a listing-shaped payload — enough to tell in-flight from settled. */
export type ListingTurn = {
  readonly status: string;
  readonly endedAt?: string | null;
};

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
  /**
   * True when this fire is already known abandoned (sidecar dead, no
   * in-flight turn). The running-window is only applied then — a live
   * fire still doing work stays `running` however old it is.
   */
  readonly abandoned?: boolean;
  /**
   * True when the listing already resolved an in-flight turn for this
   * fire. Equivalent to `turns` containing a running turn; either form
   * keeps a live tool-loop `running` past `FIRE_RUNNING_WINDOW_MS`.
   */
  readonly hasInFlightTurn?: boolean;
  /** Listing-shaped turns for this fire, when the producer attached them. */
  readonly turns?: readonly ListingTurn[];
};

/** A listing row (Insights fire, shell activity, reconstructed Mission
 * Control row, or a routine fire) from which abandonment can be derived
 * without a dedicated Interchange field. */
export type ListingRun = {
  readonly createdAt: string;
  readonly abandoned?: boolean;
  readonly hasInFlightTurn?: boolean;
  readonly turns?: readonly ListingTurn[];
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

function isInFlightTurn(turn: unknown): boolean {
  if (typeof turn !== "object" || turn === null) return false;
  const status = "status" in turn ? turn.status : undefined;
  if (status !== "running") return false;
  const endedAt = "endedAt" in turn ? turn.endedAt : undefined;
  return endedAt === undefined || endedAt === null || endedAt === "";
}

function nestedTurns(
  run: Record<string, unknown> | undefined,
): readonly unknown[] | undefined {
  const turns = run?.turns;
  return Array.isArray(turns) ? turns : undefined;
}

/**
 * How long an *abandoned* fire may linger as `running` with no `endedAt`
 * before it is read as completed (warm-keep CL-6681 / CL-6778). A finished
 * fire is supposed to land `completed`/`failed`/`cancelled` plus `endedAt`
 * via `markTerminal`; this window is last-resort for a fire already known
 * abandoned that never got that write. It is never applied to a live
 * in-flight fire — a tool loop can outlast ten minutes, and persist has
 * not settled yet.
 */
export const FIRE_RUNNING_WINDOW_MS = 10 * 60 * 1000;

type InFlightSignal = "yes" | "no" | "unknown";

function runHasInFlightTurn(run: Record<string, unknown> | undefined): boolean {
  return run?.hasInFlightTurn === true;
}

function runHasNoInFlightTurn(
  run: Record<string, unknown> | undefined,
): boolean {
  return run?.hasInFlightTurn === false;
}

/**
 * Absent `turns` / `hasInFlightTurn` is unknown, not "no in-flight turn".
 * Treating omit as empty reverts the live-tool-loop 10-minute false-complete.
 */
function listingInFlightSignal(listing: ListingRun): InFlightSignal {
  if (listing.hasInFlightTurn === true || runHasInFlightTurn(listing.run)) {
    return "yes";
  }
  if (listing.turns?.some(isInFlightTurn) === true) return "yes";
  const nested = nestedTurns(listing.run);
  if (nested?.some(isInFlightTurn) === true) return "yes";
  if (listing.turns !== undefined) return "no";
  if (nested !== undefined) return "no";
  if (listing.hasInFlightTurn === false || runHasNoInFlightTurn(listing.run)) {
    return "no";
  }
  return "unknown";
}

/**
 * A listing row has an in-flight turn when the producer said so
 * (`hasInFlightTurn`) or attached a running turn (top-level `turns` or
 * nested on `run`). A finished turn (`endedAt` set, or status other than
 * `running`) does not count. Omitted fields are unknown, not false.
 */
export function listingHasInFlightTurn(listing: ListingRun): boolean {
  return listingInFlightSignal(listing) === "yes";
}

/**
 * Abandoned only when the producer explicitly said there is no in-flight
 * turn — an empty `turns` array after a real query, or `hasInFlightTurn:
 * false` — and the fire is older than `FIRE_RUNNING_WINDOW_MS`. Omitting
 * those fields is not a no; a live tool-loop listing that has not attached
 * them must stay running.
 */
export function listingAbandoned(listing: ListingRun, now: number): boolean {
  if (listingInFlightSignal(listing) !== "no") return false;
  const startedAt = Date.parse(listing.createdAt);
  if (Number.isNaN(startedAt)) return false;
  return now - startedAt > FIRE_RUNNING_WINDOW_MS;
}

/** Pass `abandoned: true` into outcome helpers when the listing is abandoned. */
export function withListingAbandoned<T extends ListingRun>(
  listing: T,
  now: number,
): T {
  if (!listingAbandoned(listing, now)) return listing;
  return { ...listing, abandoned: true };
}

/**
 * A fire's status the way this build should show it: the raw
 * `run.status` for every non-running value; a `running` row that
 * already carries `endedAt` is finished immediately (the persist
 * path); a `running` row with an in-flight turn stays `running`
 * however old it is; a `running` row whose listing explicitly says
 * there is no in-flight turn is abandoned past `FIRE_RUNNING_WINDOW_MS`
 * and remapped to `completed`. Omitting `turns`/`hasInFlightTurn` is
 * not that signal — the fire stays `running`.
 * Every caller that needs a fire's displayed status goes through here,
 * never `fire.run?.status` directly.
 */
export function fireOutcomeStatus(
  fire: Pick<RoutineFire, "createdAt"> & {
    readonly run?: Record<string, unknown>;
    readonly abandoned?: boolean;
    readonly hasInFlightTurn?: boolean;
    readonly turns?: readonly ListingTurn[];
  },
  now: number,
): string | null {
  const status = statusOf(fire);
  if (status !== "running") return status;
  const endedAt = fire.run?.endedAt;
  if (typeof endedAt === "string" && endedAt !== "") return "completed";
  if (listingHasInFlightTurn(fire)) return status;
  const abandoned = fire.abandoned === true || listingAbandoned(fire, now);
  if (!abandoned) return status;
  const startedAt = Date.parse(fire.createdAt);
  if (Number.isNaN(startedAt)) return status;
  return now - startedAt > FIRE_RUNNING_WINDOW_MS ? "completed" : "running";
}

/**
 * `fireOutcomeStatus` for a platform run whose status lives at the top
 * level (`workflow_run.status`), not nested on a routine fire's `run`.
 * Insights, Mission Control, and the shell activity feed all see that
 * shape. `endedAt` is the persist-path signal that the fire already
 * finished. A listing-shaped payload with an in-flight turn stays
 * `running` however old it is; one that explicitly says there is no
 * in-flight turn is abandoned past `FIRE_RUNNING_WINDOW_MS` and
 * remapped to `completed`. Omitting those fields is not a no.
 */
export function runOutcomeStatus(
  run: {
    readonly createdAt: string;
    readonly status: string;
    readonly endedAt?: string | null;
    readonly abandoned?: boolean;
    readonly hasInFlightTurn?: boolean;
    readonly turns?: readonly ListingTurn[];
  },
  now: number,
): string | null {
  const listing = withListingAbandoned(run, now);
  return fireOutcomeStatus(
    {
      createdAt: listing.createdAt,
      ...(listing.abandoned === true ? { abandoned: true } : {}),
      ...(listing.hasInFlightTurn !== undefined
        ? { hasInFlightTurn: listing.hasInFlightTurn }
        : {}),
      ...(listing.turns !== undefined ? { turns: listing.turns } : {}),
      run: { status: listing.status, endedAt: listing.endedAt },
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
