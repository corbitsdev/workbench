// See docs/run-outcome-status.md.

type ListingTurn = {
  readonly status: string;
  readonly endedAt?: string | null;
};

type ListingRun = {
  readonly createdAt: string;
  readonly abandoned?: boolean;
  readonly hasInFlightTurn?: boolean;
  readonly turns?: readonly ListingTurn[];
  readonly run?: Record<string, unknown>;
};

const FIRE_RUNNING_WINDOW_MS = 10 * 60 * 1000;

type InFlightSignal = "yes" | "no" | "unknown";

function isInFlightTurn(turn: unknown): boolean {
  if (typeof turn !== "object" || turn === null) return false;
  const status = "status" in turn ? turn.status : undefined;
  if (status !== "running") return false;
  const endedAt = "endedAt" in turn ? turn.endedAt : undefined;
  return endedAt === undefined || endedAt === null || endedAt === "";
}

function listingInFlightSignal(listing: ListingRun): InFlightSignal {
  const nested = Array.isArray(listing.run?.turns) ? listing.run.turns : undefined;
  if (listing.hasInFlightTurn === true || listing.run?.hasInFlightTurn === true) return "yes";
  if (listing.turns?.some(isInFlightTurn) === true || nested?.some(isInFlightTurn) === true) {
    return "yes";
  }
  if (listing.turns !== undefined || nested !== undefined) return "no";
  if (listing.hasInFlightTurn === false || listing.run?.hasInFlightTurn === false) return "no";
  return "unknown";
}

function listingAbandoned(listing: ListingRun, now: number): boolean {
  if (listingInFlightSignal(listing) !== "no") return false;
  const startedAt = Date.parse(listing.createdAt);
  return !Number.isNaN(startedAt) && now - startedAt > FIRE_RUNNING_WINDOW_MS;
}

export function withListingAbandoned<T extends ListingRun>(listing: T, now: number): T {
  return listingAbandoned(listing, now) ? { ...listing, abandoned: true } : listing;
}

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
  if (listing.status !== "running") return listing.status;
  if (typeof listing.endedAt === "string" && listing.endedAt !== "") return "completed";
  if (listingInFlightSignal(listing) === "yes" || listing.abandoned !== true) return listing.status;
  const startedAt = Date.parse(listing.createdAt);
  if (Number.isNaN(startedAt)) return listing.status;
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

export function runStatusLabel(status: string): string {
  return RUN_STATUS_WORDS[status] ?? status;
}
