// The single status-tone vocabulary shared by every Insights status surface —
// the dashboard roster chips, the run/identity trace-header pills, and the
// per-step phase glyphs read from the SAME map, so a given status looks
// identical wherever it appears. Colors follow the brand reading of the trace
// legend: green = completed / alive, blue = in progress, gold = needs
// attention, red = failed, neutral = inert (ended / cancelled).

export type StatusTone =
  | "positive"
  | "progress"
  | "attention"
  | "danger"
  | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  positive: "bg-green/15 text-green-deep",
  progress: "bg-blue/15 text-blue-deep",
  attention: "bg-gold/15 text-gold",
  danger: "bg-red/15 text-red-deep",
  neutral: "bg-surface-2 text-text-3",
};

/** The pill/chip class for a tone — one source of truth for all status chips. */
export function statusToneClass(tone: StatusTone): string {
  return TONE_CLASS[tone];
}

/**
 * A workflow run's coarse lifecycle status → a tone. Completed is green (the
 * brand's "ran" color), a live/in-flight run is blue, a parked run is gold, a
 * failed run is red; anything inert (cancelled) or unrecognized stays neutral.
 * Accepts both the run-record statuses and the run-state phase spellings so the
 * roster and the trace header agree.
 */
export function runStatusTone(status: string): StatusTone {
  if (status === "completed") return "positive";
  if (status === "running" || status === "in-flight") return "progress";
  if (
    status === "awaiting" ||
    status === "awaiting-signal" ||
    status === "awaiting-timer"
  ) {
    return "attention";
  }
  if (status === "failed") return "danger";
  // Explicit inert terminals (user stop + native cancel) stay neutral so they
  // never pick up failed-red if the default branch ever changes.
  if (status === "stopped" || status === "cancelled") return "neutral";
  return "neutral";
}

/**
 * An agent instance's status → a tone. A running instance is alive (green); an
 * ended or otherwise inert instance is neutral. (Instance liveness is not a
 * run's in-progress state, so "running" reads green here, not blue.)
 */
export function instanceStatusTone(status: string): StatusTone {
  if (status === "running" || status === "active") return "positive";
  return "neutral";
}

/**
 * An actor/principal account status → a tone. Active is alive (green);
 * everything else (deactivated, suspended, …) is neutral rather than an
 * attention color it hasn't earned.
 */
export function actorStatusTone(status: string): StatusTone {
  if (status === "active") return "positive";
  return "neutral";
}
