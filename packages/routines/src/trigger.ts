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
 * An event-driven trigger: the routine fires when a verified delivery
 * lands on a `@corbits/webhook-triggers` row, not on any clock. The
 * only field is a reference to that row's id — `webhookTriggerId` — the
 * URL, secret, and delivery history live on the webhook-triggers side;
 * this is the pointer that makes a routine "own" that binding. The
 * referenced row's `workflowDefinitionId` must equal the routine's own
 * `definitionId` (enforced where a routine is created/updated, not
 * here — this schema has no database access), since a webhook trigger
 * and the routine it fires are two views of one binding, not two
 * independent things that happen to agree.
 */
const WebhookTrigger = type({
  kind: "'webhook'",
  webhookTriggerId: "string",
});

/**
 * A routine's trigger: one of the three cadence presets, a raw cron
 * escape hatch, an event-driven webhook binding, or `null` for a
 * manual, run-now-only routine. Every branch is validated eagerly
 * (arktype at the trust boundary) — an invalid cron string, an
 * impossible schedule, or a bad timezone is rejected at save time with
 * a specific error, never at the next scheduled fire.
 */
export const RoutineTrigger = IntervalTrigger.or(DailyTrigger)
  .or(WeeklyTrigger)
  .or(CronTrigger)
  .or(WebhookTrigger)
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
  trigger: Exclude<RoutineTriggerT, null | { kind: "webhook" }>,
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

/** Timezone the trigger's wall-clock fields are interpreted in. Only
 * meaningful for a cadence trigger — webhook and manual triggers have no
 * wall-clock fields, so this returns "UTC" for them as a harmless default. */
export function timezoneForTrigger(trigger: RoutineTriggerT): string {
  if (trigger === null || trigger.kind === "interval") return "UTC";
  if (trigger.kind === "webhook") return "UTC";
  return trigger.timezone ?? "UTC";
}

/**
 * The mode filter ids the Routines panel offers: "all" plus the three
 * cadence/trigger buckets.
 */
export type RoutineModeFilter = "all" | "schedule" | "trigger" | "demand";

/** Where a trigger sits for filtering: a manual (`null`) trigger is
 * on-demand only, a webhook trigger is event-driven ("trigger"), and every
 * cadence preset or raw cron fires on its own schedule. */
export function routineTriggerCategory(
  trigger: RoutineTriggerT,
): Exclude<RoutineModeFilter, "all"> {
  if (trigger === null) return "demand";
  if (trigger.kind === "webhook") return "trigger";
  return "schedule";
}

/** Whether a routine's trigger belongs under a mode filter chip. */
export function routineMatchesModeFilter(
  trigger: RoutineTriggerT,
  filter: RoutineModeFilter,
): boolean {
  if (filter === "all") return true;
  return routineTriggerCategory(trigger) === filter;
}

/**
 * When a routine with this trigger next fires, strictly after `after` —
 * `null` for a manual routine (which never auto-fires) or a webhook
 * routine (which fires only on a verified delivery, never on a clock).
 * Persisted as a routine's `nextFireAt` on every create, trigger/enabled
 * change, and fire, so a schedule due while the hub is down is still due
 * (not skipped) on restart: the scheduler's readiness test is
 * `nextFireAt <= now`, not "does this exact instant match."
 *
 * Daily / weekly / cron with a timezone match wall-clock in that zone
 * (DST-correct via `Intl`); the returned Date is always a UTC instant.
 */
export function computeNextFireAt(
  trigger: RoutineTriggerT,
  after: Date,
): Date | null {
  if (trigger === null || trigger.kind === "webhook") return null;
  return nextCronFireAfter(
    cronExpressionForTrigger(trigger),
    after,
    timezoneForTrigger(trigger),
  );
}

/** Cron `dayOfWeek`'s 0–6 range, spelled out — shared by every plain-
 * language rendering of a weekly trigger. */
export const ROUTINE_WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function zeroPadClock(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function zoneSuffix(timezone: string | undefined): string {
  return timezone === undefined || timezone === "UTC" ? "UTC" : timezone;
}

/**
 * The verbose, one-line cadence a routine's detail page shows: a full
 * sentence, timezone spelled out for daily/weekly, in parentheses for
 * cron. `nextCronFireAfter`'s own timezone semantics are what this reads
 * against — the wording never encodes a schedule the scheduler wouldn't
 * also compute.
 */
export function routineCadenceLabel(trigger: RoutineTriggerT): string {
  if (trigger === null) return "Manual";
  switch (trigger.kind) {
    case "webhook":
      return "On webhook";
    case "interval":
      return trigger.every === 1
        ? `Every ${trigger.unit === "minutes" ? "minute" : "hour"}`
        : `Every ${String(trigger.every)} ${trigger.unit}`;
    case "daily":
      return `Daily at ${zeroPadClock(trigger.hour, trigger.minute)} ${zoneSuffix(trigger.timezone)}`;
    case "weekly":
      return `Weekly on ${ROUTINE_WEEKDAY_NAMES[trigger.dayOfWeek]} at ${zeroPadClock(trigger.hour, trigger.minute)} ${zoneSuffix(trigger.timezone)}`;
    case "cron": {
      const zone =
        trigger.timezone !== undefined && trigger.timezone !== "UTC"
          ? ` (${trigger.timezone})`
          : "";
      return `Cron: ${trigger.expression}${zone}`;
    }
  }
}

/**
 * The terse cadence a routine row's detail slot shows: no timezone
 * suffix, a manual trigger reads as "On demand" rather than "Manual" —
 * the feed's language for a routine with nothing scheduled.
 */
export function routineCadenceSummary(trigger: RoutineTriggerT): string {
  if (trigger === null) return "On demand";
  switch (trigger.kind) {
    case "interval": {
      const unit =
        trigger.every === 1 ? trigger.unit.replace(/s$/, "") : trigger.unit;
      return `Every ${String(trigger.every)} ${unit}`;
    }
    case "daily":
      return `Daily ${zeroPadClock(trigger.hour, trigger.minute)}`;
    case "weekly":
      return `Every ${ROUTINE_WEEKDAY_NAMES[trigger.dayOfWeek] ?? "week"} ${zeroPadClock(trigger.hour, trigger.minute)}`;
    case "cron":
      return `Cron ${trigger.expression}`;
    case "webhook":
      return "On webhook";
  }
}
