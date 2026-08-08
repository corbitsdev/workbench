// The two trigger shapes a schedule can carry, and the arithmetic that
// turns one into a concrete next-run instant. `croner` is the one
// external dependency this package adds: a minimal, actively
// maintained cron parser/evaluator, rather than reimplementing cron
// field parsing (5- and 6-field expressions, ranges, steps, `L`/`W`,
// DST-aware scheduling) ourselves — a nontrivial and easy-to-get-wrong
// surface that has nothing to do with what this package actually owns
// (schedule storage, tenant-scoped CRUD, and the launch path).
import { Cron } from "croner";

export type ScheduleTrigger =
  | { readonly kind: "cron"; readonly expression: string }
  | { readonly kind: "interval"; readonly ms: number };

export class InvalidTriggerError extends Error {}

/**
 * Throws `InvalidTriggerError` for anything that would otherwise fail
 * silently at scheduling time: an unparsable cron expression, or a
 * non-positive interval. Called at write time (create/update) so a bad
 * trigger never reaches the ticking scheduler in the first place.
 */
export function validateTrigger(trigger: ScheduleTrigger): void {
  if (trigger.kind === "cron") {
    try {
      const parsed = new Cron(trigger.expression, { timezone: "UTC" });
      parsed.stop();
    } catch (cause) {
      throw new InvalidTriggerError(
        `invalid cron expression ${JSON.stringify(trigger.expression)}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    return;
  }
  if (!Number.isFinite(trigger.ms) || trigger.ms <= 0) {
    throw new InvalidTriggerError(
      `interval trigger requires a positive, finite ms; got ${trigger.ms}`,
    );
  }
}

/**
 * The next instant strictly after `from` that this trigger fires.
 * Cron uses `croner`'s own field evaluation (including DST edges);
 * interval is plain arithmetic off the last computed instant, so a
 * missed tick (the process was down) does not compound — the next run
 * is always `from + ms`, not "catch up n times".
 */
export function computeNextRun(trigger: ScheduleTrigger, from: Date): Date {
  if (trigger.kind === "cron") {
    const cron = new Cron(trigger.expression, { timezone: "UTC" });
    const next = cron.nextRun(from);
    if (next === null) {
      throw new InvalidTriggerError(
        `cron expression ${JSON.stringify(trigger.expression)} has no ` +
          `future run after ${from.toISOString()}`,
      );
    }
    return next;
  }
  return new Date(from.getTime() + trigger.ms);
}
