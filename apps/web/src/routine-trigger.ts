// Renders a `RoutineTrigger` (the wire shape `@corbits/routines` defines
// in packages/routines/src/trigger.ts) into what the Routines page shows:
// a plain-language cadence and a best-effort next-run estimate.
//
// Daily / weekly / cron may carry an optional IANA `timezone`; hour and
// minute are wall-clock in that zone (DST-correct). The estimate uses
// `nextCronFireAfter` from `@corbits/routines/cron` — the exact same
// minute-by-minute search the hub's scheduler runs against the exact
// same rendered cron expression — never a second, hand-rolled matcher
// that could drift from what actually fires. That subpath (not the
// package's default export) is deliberate: the default export pulls in
// `drizzle-orm` and `postgres` through `store.ts`, which have no business
// in a browser bundle; `cron.ts` has zero imports and bundles cleanly.
//
// An interval preset fires on a wall-clock-aligned cadence
// (`*/N * * * *`), not N minutes after whatever moment a viewer happens
// to load the page — "every 10 minutes" viewed at :07 fires at :10.
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

function zoneLabel(timezone: string | undefined): string {
  return timezone === undefined || timezone === "UTC" ? "UTC" : timezone;
}

export function cadenceLabel(trigger: RoutineTrigger): string {
  if (trigger === null) return "Manual";
  switch (trigger.kind) {
    case "webhook":
      return "On webhook";
    case "interval":
      return trigger.every === 1
        ? `Every ${trigger.unit === "minutes" ? "minute" : "hour"}`
        : `Every ${String(trigger.every)} ${trigger.unit}`;
    case "daily":
      return `Daily at ${pad(trigger.hour)}:${pad(trigger.minute)} ${zoneLabel(trigger.timezone)}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_NAMES[trigger.dayOfWeek]} at ${pad(trigger.hour)}:${pad(trigger.minute)} ${zoneLabel(trigger.timezone)}`;
    case "cron": {
      const zone =
        trigger.timezone !== undefined && trigger.timezone !== "UTC"
          ? ` (${trigger.timezone})`
          : "";
      return `Cron: ${trigger.expression}${zone}`;
    }
  }
}

/** Renders the closed-form presets to the same cron shape the scheduler fires against. */
function cronExpressionForPreset(
  trigger: Exclude<RoutineTrigger, null | { kind: "cron" | "webhook" }>,
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

function timezoneFor(trigger: Exclude<RoutineTrigger, null>): string {
  if (trigger.kind === "interval" || trigger.kind === "webhook") return "UTC";
  return trigger.timezone ?? "UTC";
}

/**
 * A best-effort next-fire estimate for display only — never fed back
 * into a launch decision, which is the scheduler's job against the real
 * clock. Returns `null` for a manual or webhook routine (neither fires
 * on a clock), or when the expression has no fire inside the lookahead
 * window.
 *
 * Raw cron is estimated the same way presets are: same package, same
 * timezone semantics as the hub.
 */
export function approximateNextRun(
  trigger: RoutineTrigger,
  now: Date,
): Date | null {
  if (trigger === null || trigger.kind === "webhook") return null;
  try {
    const expression =
      trigger.kind === "cron"
        ? trigger.expression
        : cronExpressionForPreset(trigger);
    return nextCronFireAfter(expression, now, timezoneFor(trigger));
  } catch {
    return null;
  }
}
