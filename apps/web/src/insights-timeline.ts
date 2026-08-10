// Lightweight day-bucket timeline over existing run timestamps — no new
// analytics backend. Buckets the last N UTC days (oldest first) so a small
// bar/sparkline can render honest volume from data the page already holds.

import type { WorkflowRun } from "./api";

export type DayBucket = {
  /** Calendar day as `YYYY-MM-DD` (UTC). */
  readonly key: string;
  /** Short, single-line axis label for the day. */
  readonly label: string;
  /** Purpose runs that started on this day. */
  readonly count: number;
};

/** Default window for the timeline strip. */
export const INSIGHTS_TIMELINE_DAYS = 14;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Buckets `runs` into the last `days` UTC days ending on `now`'s day, oldest
 * first. Runs outside the window are dropped; days with no runs still appear
 * as zero-count buckets so the strip never collapses.
 */
export function bucketRunsByDay(
  runs: readonly WorkflowRun[],
  days: number = INSIGHTS_TIMELINE_DAYS,
  now: Date = new Date(),
): readonly DayBucket[] {
  // Start of the current UTC day, then walk back `days - 1` days so the
  // window includes today.
  const todayUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dayMs = 86_400_000;

  const counts = new Map<string, number>();
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const ms = todayUTC - offset * dayMs;
    const d = new Date(ms);
    const key = utcDayKey(d);
    keys.push(key);
    counts.set(key, 0);
  }

  for (const run of runs) {
    const key = isoToUtcDayKey(run.createdAt);
    if (key === null) continue;
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return keys.map((key) => ({
    key,
    label: labelForKey(key),
    count: counts.get(key) ?? 0,
  }));
}

function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoToUtcDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return utcDayKey(d);
}

function labelForKey(key: string): string {
  // key is `YYYY-MM-DD`; derive a locale-independent `Mon D` label.
  const [, month, day] = key.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1]} ${day}`;
}
