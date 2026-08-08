// The Routine trigger vocabulary: three presets covering the common
// cadences, stored as structured data rather than opaque cron strings,
// plus a raw cron escape hatch for anything a preset can't express. A
// `null` trigger is a valid, first-class routine shape — a manual,
// run-now-only automation, not an error state.
import { type } from "arktype";

const CRON_FIELD =
  /^(\*|[0-9]+)(\/[0-9]+)?(-[0-9]+)?(,(\*|[0-9]+)(\/[0-9]+)?(-[0-9]+)?)*$/;

/**
 * Loud, eager validation for a raw 5-field cron expression
 * (minute hour day-of-month month day-of-week). Rejects anything that
 * isn't exactly five whitespace-separated fields built from the
 * standard `*`, `,`, `-`, `/` cron grammar — never silently accepts a
 * malformed schedule that would then fail at fire-time instead of at
 * save-time.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => CRON_FIELD.test(field));
}

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
