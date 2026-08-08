// Renders a `RoutineTrigger` (the wire shape `@corbits/routines` defines
// in packages/routines/src/trigger.ts) into what the Routines page shows:
// a plain-language cadence and a best-effort next-run estimate. Kept
// pure and UTC-only — a `RoutineTrigger` carries no timezone, so neither
// does this. The raw-cron escape hatch has no closed-form "next
// occurrence" here (the scheduler itself resolves that minute by minute;
// see apps/hub/src/cron-due.ts) — it renders a plain description instead
// of a guessed timestamp, never a wrong one dressed up as exact.
//
// The estimate for interval/daily/weekly presets is derived from the
// exact cron expression the scheduler fires against (mirroring
// `cronExpressionForTrigger` and a minute-by-minute search, the same
// technique as `nextCronFireAfter` in packages/routines/src/cron.ts),
// not from naive arithmetic on `now`. An interval preset in particular
// fires on a wall-clock-aligned cadence (`*/N * * * *`), not N minutes
// after whatever moment a viewer happens to load the page — "every 10
// minutes" viewed at :07 fires at :10, four minutes away, not ten.
import type { RoutineTrigger } from "./routines-api";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function cadenceLabel(trigger: RoutineTrigger): string {
  if (trigger === null) return "Manual";
  switch (trigger.kind) {
    case "interval":
      return trigger.every === 1
        ? `Every ${trigger.unit === "minutes" ? "minute" : "hour"}`
        : `Every ${String(trigger.every)} ${trigger.unit}`;
    case "daily":
      return `Daily at ${pad(trigger.hour)}:${pad(trigger.minute)} UTC`;
    case "weekly":
      return `Weekly on ${WEEKDAY_NAMES[trigger.dayOfWeek]} at ${pad(trigger.hour)}:${pad(trigger.minute)} UTC`;
    case "cron":
      return `Cron: ${trigger.expression}`;
  }
}

/** Renders the closed-form presets to the same cron shape the scheduler fires against. */
function cronExpressionForPreset(
  trigger: Exclude<RoutineTrigger, null | { kind: "cron" }>,
): string {
  switch (trigger.kind) {
    case "interval":
      return trigger.unit === "minutes"
        ? `*/${trigger.every} * * * *`
        : `0 */${trigger.every} * * *`;
    case "daily":
      return `${trigger.minute} ${trigger.hour} * * *`;
    case "weekly":
      return `${trigger.minute} ${trigger.hour} * * ${trigger.dayOfWeek}`;
  }
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  const stepMatch = /^\*\/([0-9]+)$/.exec(field);
  if (stepMatch?.[1] !== undefined) return value % Number(stepMatch[1]) === 0;
  return value === Number(field);
}

/**
 * Matches the subset of the 5-field cron grammar `cronExpressionForPreset`
 * ever renders: `*`, a bare number, or a step of `*` (e.g. `star-slash-N`)
 * — day-of-month and month are always `*` for these presets, so only
 * minute/hour/day-of-week vary.
 */
function presetCronMatchesMinute(expression: string, at: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.split(" ");
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return false;
  }
  return (
    cronFieldMatches(minute, at.getUTCMinutes()) &&
    cronFieldMatches(hour, at.getUTCHours()) &&
    dayOfMonth === "*" &&
    month === "*" &&
    cronFieldMatches(dayOfWeek, at.getUTCDay())
  );
}

const NEXT_RUN_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** The next minute at or after `after` (exclusive) that `expression` matches. */
function nextPresetFireAfter(expression: string, after: Date): Date | null {
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (
    let candidateMs = start;
    candidateMs - start <= NEXT_RUN_LOOKAHEAD_MS;
    candidateMs += 60_000
  ) {
    const candidate = new Date(candidateMs);
    if (presetCronMatchesMinute(expression, candidate)) return candidate;
  }
  return null;
}

/**
 * A best-effort next-fire estimate for display only — never fed back
 * into a launch decision, which is the scheduler's job
 * (apps/hub/src/routine-scheduler.ts) against the real clock. Returns
 * `null` for a manual routine or a raw-cron trigger (no closed form
 * without a full cron evaluator on the client).
 */
export function approximateNextRun(
  trigger: RoutineTrigger,
  now: Date,
): Date | null {
  if (trigger === null || trigger.kind === "cron") return null;
  return nextPresetFireAfter(cronExpressionForPreset(trigger), now);
}
