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
// hand-rolled matcher that could drift from what actually fires. Neither
// subpath (not the package's default export) pulls in `drizzle-orm` and
// `postgres` through `store.ts`, which have no business in a browser
// bundle.
//
// An interval preset fires on a wall-clock-aligned cadence
// (`*/N * * * *`), not N minutes after whatever moment a viewer happens
// to load the page — "every 10 minutes" viewed at :07 fires at :10.
import { nextCronFireAfter } from "@corbits/routines/cron";
import { routineCadenceLabel } from "@corbits/routines/trigger";
import type { RoutineTrigger } from "./routines-api";

export const cadenceLabel = routineCadenceLabel;

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
