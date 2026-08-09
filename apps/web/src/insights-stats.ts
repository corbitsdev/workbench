// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import type { WorkflowRun } from "./api";
import type { Routine } from "./routines-api";

export type InsightsStats = {
  readonly totalRuns: number;
  readonly running: number;
  readonly errored: number;
  readonly stopped: number;
  readonly deployed: number;
  readonly routineCount: number;
  readonly enabledRoutines: number;
  readonly recentRuns: readonly WorkflowRun[];
};

/** Cap recent-run table rows so the page stays scannable. */
export const INSIGHTS_RECENT_LIMIT = 12;

/** Purpose runs only — drop channel-host anchors the same way Home does. */
export function purposeRunsForInsights(
  runs: readonly WorkflowRun[],
): readonly WorkflowRun[] {
  return runs.filter((run) => !isChannelHostDefinitionName(run.definitionName));
}

export function computeInsightsStats(
  runs: readonly WorkflowRun[],
  routines: readonly Routine[],
  recentLimit: number = INSIGHTS_RECENT_LIMIT,
): InsightsStats {
  const purposeful = purposeRunsForInsights(runs);
  let running = 0;
  let errored = 0;
  let stopped = 0;
  let deployed = 0;
  for (const run of purposeful) {
    switch (run.status) {
      case "running":
      case "updating":
        running += 1;
        break;
      case "error":
        errored += 1;
        break;
      case "stopped":
        stopped += 1;
        break;
      case "deployed":
        deployed += 1;
        break;
    }
  }

  const recentRuns = [...purposeful]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, recentLimit);

  return {
    totalRuns: purposeful.length,
    running,
    errored,
    stopped,
    deployed,
    routineCount: routines.length,
    enabledRoutines: routines.filter((r) => r.enabled).length,
    recentRuns,
  };
}
