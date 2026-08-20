// One state → tone table for a routine's health, shared by the Routines
// list's pill and the detail page's health rail. DESIGN.md's State Pills
// rule is what makes this a table and not two inline ternaries: the four
// live states never share a colour, so the mapping has to exist in exactly
// one place or two screens will disagree about what "failing" looks like.
//
// `failing` (still scheduled, still retrying) reads warning; `paused`
// (dead-lettered, the scheduler gave up) reads danger — a routine that has
// stopped for good is not the same signal as one having a bad morning.
//
// This table belongs next to `health.ts` in the routines package, since
// the state→tone pairing is as much a product rule as the states
// themselves; it sits here only because `BadgeTone` is a react-ui type and
// the package has no react-ui dependency yet. Moving both is ticketed.
import type { BadgeTone } from "@corbits/react-ui";
import type { RoutineHealthState } from "@corbits/routines/client";

export const ROUTINE_HEALTH_TONE: Readonly<
  Record<RoutineHealthState, BadgeTone>
> = {
  off: "neutral",
  idle: "neutral",
  ok: "success",
  running: "info",
  failing: "warning",
  paused: "danger",
};
