// The Routine trigger vocabulary: three presets covering the common
// cadences, stored as structured data rather than opaque cron strings,
// plus a raw cron escape hatch for anything a preset can't express. A
// `null` trigger is a valid, first-class routine shape — a manual,
// run-now-only automation, not an error state.
//
// Optional `timezone` (IANA) on daily / weekly / cron: hour and minute
// (and day-of-week for weekly/cron) are wall-clock in that zone;
// `nextFireAt` is still a UTC instant. Interval is absolute UTC cadence
// and does not carry a timezone. Omitted timezone means UTC, matching
// every routine that existed before this field.
import { type } from "arktype";

import {
  cronExpressionCanFire,
  isValidCronExpression,
  isValidTimeZone,
  nextCronFireAfter,
} from "./cron";

export {
  isValidCronExpression,
  isValidTimeZone,
  cronMatchesMinute,
  cronExpressionCanFire,
  minuteKey,
} from "./cron";

const TimezoneField = type("string").narrow((value, ctx) => {
  if (isValidTimeZone(value)) return true;
  return ctx.reject(
    `"${value}" is not a recognised IANA timezone (e.g. "America/Los_Angeles", "UTC")`,
  );
});

const IntervalTrigger = type({
  kind: "'interval'",
  unit: "'minutes' | 'hours'",
  every: "number.integer > 0",
});

const DailyTrigger = type({
  kind: "'daily'",
  hour: "0 <= number.integer <= 23",
  minute: "0 <= number.integer <= 59",
  "timezone?": TimezoneField,
});

const WeeklyTrigger = type({
  kind: "'weekly'",
  dayOfWeek: "0 <= number.integer <= 6",
  hour: "0 <= number.integer <= 23",
  minute: "0 <= number.integer <= 59",
  "timezone?": TimezoneField,
});

const CronTrigger = type({
  kind: "'cron'",
  expression: "string",
  "timezone?": TimezoneField,
}).narrow((value, ctx) => {
  if (!isValidCronExpression(value.expression)) {
    return ctx.reject(
      `"${value.expression}" is not a valid 5-field cron expression ` +
        `(minute hour day-of-month month day-of-week)`,
    );
  }
  const zone = value.timezone ?? "UTC";
  if (!cronExpressionCanFire(value.expression, zone)) {
    return ctx.reject(
      `"${value.expression}" never fires within a year` +
        (zone === "UTC" ? "" : ` in ${zone}`) +
        ` — impossible schedules are rejected at save time`,
    );
  }
  return true;
});

/**
 * A routine's trigger: one of the three presets, a raw cron escape
 * hatch, or `null` for a manual, run-now-only routine. Every branch is
 * validated eagerly (arktype at the trust boundary) — an invalid cron
 * string, an impossible schedule, or a bad timezone is rejected at save
 * time with a specific error, never at the next scheduled fire.
 */
export const RoutineTrigger = IntervalTrigger.or(DailyTrigger)
  .or(WeeklyTrigger)
  .or(CronTrigger)
  .or("null");

export type RoutineTriggerT = typeof RoutineTrigger.infer;

/**
 * Renders any trigger shape to a canonical cron expression, the single
 * form the scheduler actually runs against — presets are sugar over
 * this, never a second execution path. Timezone is *not* encoded in the
 * expression; it is applied when matching/searching (see
 * `computeNextFireAt`).
 */
export function cronExpressionForTrigger(
  trigger: Exclude<RoutineTriggerT, null>,
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
    case "cron":
      return trigger.expression;
  }
}

/** Timezone the trigger's wall-clock fields are interpreted in. */
export function timezoneForTrigger(trigger: RoutineTriggerT): string {
  if (trigger === null || trigger.kind === "interval") return "UTC";
  return trigger.timezone ?? "UTC";
}

/**
 * When a routine with this trigger next fires, strictly after `after` —
 * `null` for a manual routine, which never auto-fires. Persisted as a
 * routine's `nextFireAt` on every create, trigger/enabled change, and
 * fire, so a schedule due while the hub is down is still due (not
 * skipped) on restart: the scheduler's readiness test is `nextFireAt <=
 * now`, not "does this exact instant match."
 *
 * Daily / weekly / cron with a timezone match wall-clock in that zone
 * (DST-correct via `Intl`); the returned Date is always a UTC instant.
 */
export function computeNextFireAt(
  trigger: RoutineTriggerT,
  after: Date,
): Date | null {
  if (trigger === null) return null;
  return nextCronFireAfter(
    cronExpressionForTrigger(trigger),
    after,
    timezoneForTrigger(trigger),
  );
}
