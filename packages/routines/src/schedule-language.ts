// Every schedule a person reads, as a sentence — the only renderer in the
// package. DESIGN.md's Copy rule is absolute: "cron expressions render as
// human sentences ('every weekday at 9am'), never as the raw expression,
// in any surface a person reads them", and the preset-shaped switch this
// module replaced could not honour it — an arbitrary expression has no
// preset to read, so its `cron` branch printed `Cron: 0 9 * * 1-5`
// verbatim into the routines list, the schedule editor's live summary, the
// canvas panel's trigger rows, and the in-workbench "routine created"
// notice alike.
//
// `cronstrue` (MIT, zero runtime dependencies, browser-safe) is the
// normalizer, not a hand-rolled one: the product's cron escape hatch
// accepts any 5-field expression `./cron.ts` validates, so the renderer
// has to cover the same grammar rather than the handful of shapes
// `cronExpressionForTrigger` happens to emit.
//
// Two rules keep the sentences honest rather than merely mechanical:
//
// - An interval trigger keeps the schedule editor's own words ("Every 15
//   minutes"), not cron's reading of the equivalent expression ("On the
//   hour, every 6 hours"). One cadence, one phrasing, wherever a person
//   meets it.
// - The timezone is named only when the schedule actually has a wall
//   clock to read in that zone. "Every 15 minutes (UTC)" says nothing —
//   the cadence is identical in every zone on earth.
import { toString as describeCronExpression } from "cronstrue";

import { cronExpressionForTrigger, timezoneForTrigger } from "./trigger";
import type { RoutineTriggerT } from "./trigger";

/** A cron field is unpinned when it matches every value in its range —
 * a bare star, or a star with a step (which pins a cadence, not a clock
 * reading). */
function fieldIsUnpinned(field: string): boolean {
  return /^\*(\/\d+)?$/.test(field);
}

/**
 * True when the expression names a time of day — an hour or a minute
 * someone could point at on a clock. A step-every-15-minutes expression
 * does not; `0 9 * * *` does, and only then does the zone it is read in
 * mean anything.
 */
export function cronHasWallClock(expression: string): boolean {
  const [minute, hour] = expression.trim().split(/\s+/);
  if (minute === undefined || hour === undefined) return false;
  return !fieldIsUnpinned(minute) || !fieldIsUnpinned(hour);
}

/**
 * A raw 5-field cron expression as an English sentence, naming its
 * timezone when the schedule has a wall clock to read in it — `null` when
 * the expression is not describable, so a caller can show the person
 * their own invalid input instead of a confident sentence about a
 * schedule that will never fire.
 */
export function cronSentence(
  expression: string,
  timezone: string = "UTC",
): string | null {
  let described: string;
  try {
    described = describeCronExpression(expression, {
      verbose: false,
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
  } catch {
    return null;
  }
  if (described === "") return null;
  return cronHasWallClock(expression)
    ? `${described} (${timezone})`
    : described;
}

/** "Every 15 minutes" / "Every hour" — the schedule editor's own words for
 * an interval cadence, which has no wall clock and so no timezone. */
function intervalSentence(
  trigger: Extract<RoutineTriggerT, { kind: "interval" }>,
): string {
  if (trigger.every === 1) {
    const singular = { minutes: "minute", hours: "hour", days: "day" }[
      trigger.unit
    ];
    return `Every ${singular}`;
  }
  return `Every ${String(trigger.every)} ${trigger.unit}`;
}

/**
 * Any trigger shape as one human sentence — the single rendering every
 * routines surface uses for "when does this run". Wall-clock triggers
 * (daily, weekly, raw cron) route through the canonical cron expression
 * the scheduler itself fires on, so the sentence can never describe a
 * cadence the scheduler wouldn't also compute.
 */
export function routineScheduleSentence(trigger: RoutineTriggerT): string {
  if (trigger === null) return "On demand only";
  if (trigger.kind === "webhook") return "When its webhook receives a delivery";
  if (trigger.kind === "once") return "Once, when it was created";
  if (trigger.kind === "interval") return intervalSentence(trigger);
  const sentence = cronSentence(
    cronExpressionForTrigger(trigger),
    timezoneForTrigger(trigger),
  );
  return sentence ?? "Schedule not readable";
}
