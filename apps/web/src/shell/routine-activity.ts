// deleted `@corbits/run-scope`'s `/top-level-runs?feed=fires`
// route — the only listing that kept a routine's fire despite it not
// being a top-level run — and the native `GET /workflows/runs` listing
// has no equivalent: its top-level-only predicate drops every routine
// fire by construction, and its rows carry no routine attribution to
// compose client-side from (matching fires to routines by definition
// name here would be exactly the slug guess the Insights feed refuses
// to do). So `listRoutineActivity` resolves no items without fetching:
// the shell's "Running" band and Mission Control's active-run count
// honestly report no routine activity until a native fires
// equivalent exists, instead of deriving routine activity from
// top-level deployment rows that are not routine fires. The
// `RoutineActivityItem` shape is kept so both consumers keep compiling
// against the seam in `./bench-activity.ts`.
import type { ListingTurn } from "@corbits/workflows/client";

export type RoutineActivityItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly hasInFlightTurn?: boolean;
  readonly turns?: readonly ListingTurn[];
};

export function listRoutineActivity(): Promise<readonly RoutineActivityItem[]> {
  return Promise.resolve([]);
}
