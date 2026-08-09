// The Routine trigger vocabulary: three presets covering the common
// cadences, stored as structured data rather than opaque cron strings,
// plus a raw cron escape hatch for anything a preset can't express. A
// `null` trigger is a valid, first-class routine shape — a manual,
// run-now-only automation, not an error state.
import { type } from "arktype";

import { isValidCronExpression, nextCronFireAfter } from "./cron";

export { isValidCronExpression, cronMatchesMinute, minuteKey } from "./cron";

const IntervalTrigger = type({
  kind: "'interval'",
  unit: "'minutes' | 'hours'",
  every: "number.integer > 0",
});

const DailyTrigger = type({
  kind: "'daily'",
  hour: "0 <= number.integer <= 23",
  minute: "0 <= number.integer <= 59",
});

const WeeklyTrigger = type({
  kind: "'weekly'",
  dayOfWeek: "0 <= number.integer <= 6",
  hour: "0 <= number.integer <= 23",
  minute: "0 <= number.integer <= 59",
});

const CronTrigger = type({
  kind: "'cron'",
  expression: "string",
}).narrow((value, ctx) => {
  if (isValidCronExpression(value.expression)) return true;
  return ctx.reject(
    `"${value.expression}" is not a valid 5-field cron expression ` +
      `(minute hour day-of-month month day-of-week)`,
  );
});

/**
 * A routine's trigger: one of the three presets, a raw cron escape
 * hatch, or `null` for a manual, run-now-only routine. Every branch is
 * validated eagerly (arktype at the trust boundary) — an invalid cron
 * string or an out-of-range preset field is rejected at save time with
 * a specific error, never at the next scheduled fire.
 */
export const RoutineTrigger = IntervalTrigger.or(DailyTrigger)
  .or(WeeklyTrigger)
  .or(CronTrigger)
  .or("null");

export type RoutineTriggerT = typeof RoutineTrigger.infer;

/**
 * Renders any trigger shape to a canonical cron expression, the single
 * form the scheduler actually runs against — presets are sugar over
 * this, never a second execution path.
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

/**
 * When a routine with this trigger next fires, strictly after `after` —
 * `null` for a manual routine, which never auto-fires. Persisted as a
 * routine's `nextFireAt` on every create, trigger/enabled change, and
 * fire, so a schedule due while the hub is down is still due (not
 * skipped) on restart: the scheduler's readiness test is `nextFireAt <=
 * now`, not "does this exact instant match."
 */
export function computeNextFireAt(
  trigger: RoutineTriggerT,
  after: Date,
): Date | null {
  if (trigger === null) return null;
  return nextCronFireAfter(cronExpressionForTrigger(trigger), after);
}
