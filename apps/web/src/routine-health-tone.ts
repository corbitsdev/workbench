// One state → tone table for a routine's health, shared by the Routines
// list's pill and the detail page's health rail. DESIGN.md's State Pills
// rule is what makes this a table and not two inline ternaries: the four
// live states never share a colour, so the mapping has to exist in exactly
// one place or two screens will disagree about what "failing" looks like.
//
// `failing` (still scheduled, still retrying) reads warning; `paused`
// (dead-lettered, the scheduler gave up) reads danger — a routine that has
// stopped for good is not the same signal as one having a bad morning.
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
