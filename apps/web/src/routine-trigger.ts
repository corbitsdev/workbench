// Renders a `RoutineTrigger` (the wire shape `@corbits/routines` defines
// in packages/routines/src/trigger.ts) into what the Routines page shows:
// a plain-language cadence and a best-effort next-run estimate.
//
// The cadence line itself is `routineCadenceLabel` from
// `@corbits/routines/trigger` — the same subpath `routines-page.tsx`
// pulls `routineMatchesModeFilter` from, and for the same reason: a
// product rule about how a cadence reads belongs with the routines
// domain, not this app. `nextCronFireAfter` from `@corbits/routines/cron`
// is the exact same minute-by-minute search the hub's scheduler runs
// against the exact same rendered cron expression — never a second,
// hand-rolled matcher that could drift from what actually fires.
// `cronExpressionForTrigger`/`timezoneForTrigger` are the same package's
// own preset-to-cron renderer — this module used to hand-roll a second
// copy of that switch; it now reuses the one the scheduler and the
// schedule editor both already depend on. Neither subpath (not the
// package's default export) pulls in `drizzle-orm` and `postgres` through
// `store.ts`, which have no business in a browser bundle.
import { nextCronFireAfter } from "@corbits/routines/cron";
import {
  cronExpressionForTrigger,
  routineCadenceLabel,
  routineCadenceSummary,
  timezoneForTrigger,
} from "@corbits/routines/trigger";
import type { RoutineTrigger } from "./routines-api";

export const cadenceLabel = routineCadenceLabel;
export const cadenceSummary = routineCadenceSummary;

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
  if (
    trigger === null ||
    trigger.kind === "webhook" ||
    trigger.kind === "once"
  ) {
    return null;
  }
  try {
    return nextCronFireAfter(
      cronExpressionForTrigger(trigger),
      now,
      timezoneForTrigger(trigger),
    );
  } catch {
    return null;
  }
}
