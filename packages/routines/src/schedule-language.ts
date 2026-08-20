// Every schedule a person reads, as a sentence. DESIGN.md's Copy rule is
// absolute: "cron expressions render as human sentences ('every weekday
// at 9am'), never as the raw expression, in any surface a person reads
// them" — and `routineCadenceLabel`'s `cron` branch broke it, printing
// `Cron: 0 9 * * 1-5` verbatim because a preset-shaped switch has no way
// to read an arbitrary expression.
//
// `cronstrue` (MIT, zero runtime dependencies, browser-safe) is the
// normalizer, not a hand-rolled one: the product's own cron escape hatch
// accepts any 5-field expression `./cron.ts` validates, so the renderer
// has to cover the same grammar rather than the handful of shapes
// `cronExpressionForTrigger` happens to emit.
//
// Times render 24-hour to match `routineCadenceLabel`'s existing clock
// format, and the timezone is appended parenthetically — the wall clock a
// sentence describes is meaningless without the zone it is read in.
import { toString as describeCronExpression } from "cronstrue";

import { cronExpressionForTrigger, timezoneForTrigger } from "./trigger";
import type { RoutineTriggerT } from "./trigger";

/**
 * A raw 5-field cron expression as an English sentence, with its
 * timezone named — `null` when the expression is not describable, so a
 * caller can show the person their own invalid input instead of a
 * confident sentence about a schedule that will never fire.
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
  return `${described} (${timezone})`;
}

/**
 * Any trigger shape as one human sentence — the single rendering every
 * routines surface uses for "when does this run". Clock-driven triggers
 * (interval, daily, weekly, raw cron) route through the canonical cron
 * expression the scheduler itself fires on, so the sentence can never
 * describe a cadence the scheduler wouldn't also compute.
 */
export function routineScheduleSentence(trigger: RoutineTriggerT): string {
  if (trigger === null) return "On demand only";
  if (trigger.kind === "webhook") return "When its webhook receives a delivery";
  if (trigger.kind === "once") return "Once, when it was created";
  const sentence = cronSentence(
    cronExpressionForTrigger(trigger),
    timezoneForTrigger(trigger),
  );
  return sentence ?? "Schedule not readable";
}
