// The native runs listing has no routine-fires equivalent, so this
// resolves no items rather than deriving activity from rows that aren't
// routine fires — an honest "none" until that equivalent exists.
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
