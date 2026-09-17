// The cron half of `@intx/workflow-host`'s scheduler seam. That seam is
// the single writer of `TimerFired`; a `TimerSet` carrying a `cron`
// discriminator is never replayed when its `fireAt` has passed, because
// "the next cron tick is committed by whoever owns the cron" — the run.
// This module is that owner's arithmetic: which instant the next tick
// falls on, and what the re-armed `TimerSet` looks like.
import { nextCronFireAfter } from "./cron";

/**
 * The cron-flagged `TimerSet` payload the scheduler seam ingests. The
 * on-disk workflow-event envelope is flat (`{ seq, type, ...fields }`);
 * `seq` is minted by the committing writer, so it is not part of this
 * shape.
 */
export type CronTimerSet = {
  readonly timerId: string;
  readonly fireAt: string;
  readonly cron: string;
};

export type CronTimerArmOpts = {
  /** The definition's `ScheduleTrigger.cron`, 5-field. */
  readonly cron: string;
  /** Wall clock the run is arming at. */
  readonly now: Date;
  /**
   * When the tick this arm re-arms after fired. A `TimerFired` observed
   * late — the run was suspended, or the host restarted — must not
   * re-arm a tick at or before `now`: the seam drops a past-due cron
   * `TimerSet` as a missed tick and the schedule would stall forever.
   */
  readonly firedAt?: Date;
  /** IANA zone the expression is read in; the instant is always UTC. */
  readonly timeZone?: string;
  /** Names the tick. Given the instant it falls on, so an identity can be
   * derived from it rather than minted. */
  readonly newTimerId: (fireAt: Date) => string;
};

/**
 * The next cron tick as a `TimerSet`, armed strictly in the future.
 * Missed ticks between `firedAt` and `now` are skipped rather than
 * replayed, matching the seam's recovery semantics.
 */
export function armCronTimer(opts: CronTimerArmOpts): CronTimerSet {
  const from =
    opts.firedAt !== undefined && opts.firedAt.getTime() > opts.now.getTime()
      ? opts.firedAt
      : opts.now;
  const fireAt = nextCronFireAfter(opts.cron, from, opts.timeZone ?? "UTC");
  return {
    timerId: opts.newTimerId(fireAt),
    fireAt: fireAt.toISOString(),
    cron: opts.cron,
  };
}
