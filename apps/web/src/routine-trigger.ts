// Renders a `RoutineTrigger` (the wire shape `@corbits/routines` defines
// in packages/routines/src/trigger.ts) into what the Routines page shows:
// a plain-language cadence and a best-effort next-run estimate. Kept
// pure and UTC-only — a `RoutineTrigger` carries no timezone, so neither
// does this. The raw-cron escape hatch has no closed-form "next
// occurrence" here (the scheduler itself resolves that minute by minute;
// see apps/hub/src/cron-due.ts) — it renders a plain description instead
// of a guessed timestamp, never a wrong one dressed up as exact.
//
// The estimate for interval/daily/weekly presets is computed by
// `nextCronFireAfter` from `@corbits/routines/cron` — the exact same
// minute-by-minute search the hub's own scheduler runs against the
// exact same rendered cron expression — never a second, hand-rolled
// matcher that could drift from what actually fires. That subpath (not
// the package's default export) is deliberate: the default export
// pulls in `drizzle-orm` and `postgres` through `store.ts`, which have
// no business in a browser bundle; `cron.ts` has zero imports and
// bundles cleanly on its own. An interval preset in particular fires
// on a wall-clock-aligned cadence (`*/N * * * *`), not N minutes after
// whatever moment a viewer happens to load the page — "every 10
// minutes" viewed at :07 fires at :10, four minutes away, not ten.
import { nextCronFireAfter } from "@corbits/routines/cron";
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

/**
 * A best-effort next-fire estimate for display only — never fed back
 * into a launch decision, which is the scheduler's job
 * (apps/hub/src/routine-scheduler.ts) against the real clock. Returns
 * `null` for a manual routine, a raw-cron trigger (no closed form
 * without rendering it through the same package the hub already does),
 * or the vanishingly unlikely case of no match inside
 * `nextCronFireAfter`'s multi-year lookahead.
 */
export function approximateNextRun(
  trigger: RoutineTrigger,
  now: Date,
): Date | null {
  if (trigger === null || trigger.kind === "cron") return null;
  try {
    return nextCronFireAfter(cronExpressionForPreset(trigger), now);
  } catch {
    return null;
  }
}
