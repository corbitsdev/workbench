// A platform run's status the way surfaces should show it, and its words.
// See docs/run-outcome-status.md.

/** One turn on a listing-shaped payload — enough to tell in-flight from settled. */
export type ListingTurn = {
  readonly status: string;
  readonly endedAt?: string | null;
};

/** A listing row (Insights fire, shell activity, reconstructed Mission
 * Control row) from which abandonment can be derived without a dedicated
 * Interchange field. */
export type ListingRun = {
  readonly createdAt: string;
  readonly abandoned?: boolean;
  readonly hasInFlightTurn?: boolean;
  readonly turns?: readonly ListingTurn[];
  readonly run?: Record<string, unknown>;
};

function isInFlightTurn(turn: unknown): boolean {
  if (typeof turn !== "object" || turn === null) return false;
  const status = "status" in turn ? turn.status : undefined;
  if (status !== "running") return false;
  const endedAt = "endedAt" in turn ? turn.endedAt : undefined;
  return endedAt === undefined || endedAt === null || endedAt === "";
}

function nestedTurns(run: Record<string, unknown> | undefined): readonly unknown[] | undefined {
  const turns = run?.turns;
  return Array.isArray(turns) ? turns : undefined;
}

/** How long an abandoned fire may linger as `running` with no `endedAt`
 * before it reads as completed. See docs/run-outcome-status.md. */
export const FIRE_RUNNING_WINDOW_MS = 10 * 60 * 1000;

type InFlightSignal = "yes" | "no" | "unknown";

function runHasInFlightTurn(run: Record<string, unknown> | undefined): boolean {
  return run?.hasInFlightTurn === true;
}

function runHasNoInFlightTurn(run: Record<string, unknown> | undefined): boolean {
  return run?.hasInFlightTurn === false;
}

/** Absent `turns`/`hasInFlightTurn` is unknown, not "no in-flight turn". */
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

/** A listing row has an in-flight turn when the producer said so or attached
 * a running turn. Omitted fields are unknown, not false. */
export function listingHasInFlightTurn(listing: ListingRun): boolean {
  return listingInFlightSignal(listing) === "yes";
}

/** Abandoned only when the producer explicitly said there is no in-flight
 * turn and the fire is older than `FIRE_RUNNING_WINDOW_MS`. */
export function listingAbandoned(listing: ListingRun, now: number): boolean {
  if (listingInFlightSignal(listing) !== "no") return false;
  const startedAt = Date.parse(listing.createdAt);
  if (Number.isNaN(startedAt)) return false;
  return now - startedAt > FIRE_RUNNING_WINDOW_MS;
}

/** Pass `abandoned: true` into outcome helpers when the listing is abandoned. */
export function withListingAbandoned<T extends ListingRun>(listing: T, now: number): T {
  if (!listingAbandoned(listing, now)) return listing;
  return { ...listing, abandoned: true };
}

/** `runOutcomeStatus` for a platform run whose status lives at the top level
 * (`workflow_run.status`). See docs/run-outcome-status.md. */
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
  const status = listing.status;
  if (status !== "running") return status;
  const endedAt = listing.endedAt;
  if (typeof endedAt === "string" && endedAt !== "") return "completed";
  if (listingHasInFlightTurn(listing)) return status;
  const abandoned = listing.abandoned === true;
  if (!abandoned) return status;
  const startedAt = Date.parse(listing.createdAt);
  if (Number.isNaN(startedAt)) return status;
  return now - startedAt > FIRE_RUNNING_WINDOW_MS ? "completed" : "running";
}

const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  running: "Running now",
  updating: "Running now",
  completed: "Finished",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  queued: "Waiting to start",
  pending: "Waiting to start",
};

/** A platform run status as words. */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_WORDS[status] ?? status;
}
