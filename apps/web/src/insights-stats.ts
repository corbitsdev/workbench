// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { runOutcomeStatus, withListingAbandoned } from "@corbits/workflows/client";

import type { InsightsRun } from "./insights-api";
import type { ScheduledWorkflowDefinition } from "./routines-api";

/** Compact integer; null/undefined → em-dash. Lifted out of the deleted
 * `@corbits/insights/client` — this app's own copy since it has
 * no other browser-safe home now that the package is gone. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/** "1.2s" / "3.4m" duration label — same lift as `formatCount` above. */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export type InsightsStats = {
  readonly totalRuns: number;
  readonly running: number;
  readonly errored: number;
  readonly stopped: number;
  readonly deployed: number;
  readonly routineCount: number;
  readonly enabledRoutines: number;
  readonly recentRuns: readonly InsightsRun[];
};

/** Cap recent-run table rows so the page stays scannable. */
export const INSIGHTS_RECENT_LIMIT = 12;

/**
 * Purpose runs only. `insights-page.tsx` sources `runs` from
 * `insightsTopLevelRunsPath` (see `./insights-api.ts`), the native `GET
 * /workflows/runs` top-level listing whose own predicate already
 * excludes every non-top-level run — no workbench-host anchors exist to
 * filter post-cutover, so this is now an identity pass kept for
 * callers that still name it explicitly.
 */
export function purposeRunsForInsights(runs: readonly InsightsRun[]): readonly InsightsRun[] {
  return runs;
}

/**
 * A run's human-facing name: its routine's name when the feed
 * attributed one, honestly falling back to the definition name for a run
 * with no routine attribution — e.g. every row of the native
 * `GET /workflows/runs` listing, which carries no
 * `routineName`, or a directly launched workflow. Never mapped from a
 * client-side lookup table.
 */
export function runDisplayName(run: InsightsRun): string {
  return run.routineName ?? run.definitionName;
}

/**
 * Keep runs whose `createdAt` falls inside `[fromIso, toIso]` (inclusive).
 * Invalid timestamps are dropped so KPIs never invent rows.
 */
export type DefinitionRunGroup = {
  /** `routineId` when the newest run in the group fired from one,
   * else `definitionId` — two different routines sharing one
   * definition (e.g. two workbench-digest schedules) never merge into
   * one group. The native `GET /workflows/runs` feed carries
   * no routine attribution, so in practice this is always `definitionId`
   * until a fires equivalent exists — the `routineId` branch is kept for
   * that feed, not removed. */
  readonly groupKey: string;
  readonly displayName: string;
  /** Newest run first. */
  readonly runs: readonly InsightsRun[];
};

/**
 * "Run history" grouping for the Insights runs page: the same feed already
 * fetched for the flat list, bucketed by routine (falling back to
 * definition, for a run with no routine parent) and sorted newest-run
 * first — a client-side grouping of already-fetched data, no new endpoint.
 * With the native feed every row lacks routine attribution, so every
 * group is definition-keyed today; the routine branch rejoins once a
 * fires equivalent exists. Group order follows each group's own newest
 * run, newest overall first.
 */
export function groupRunsByDefinition(runs: readonly InsightsRun[]): readonly DefinitionRunGroup[] {
  const byGroupKey = new Map<string, InsightsRun[]>();
  for (const run of runs) {
    const groupKey = run.routineId ?? run.definitionId;
    const bucket = byGroupKey.get(groupKey);
    if (bucket === undefined) {
      byGroupKey.set(groupKey, [run]);
    } else {
      bucket.push(run);
    }
  }
  const groups = [...byGroupKey.entries()].map(([groupKey, group]) => {
    const runs = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Name from the newest run, after sorting — a routine or definition
    // rename must show the current name in the group header, not
    // whatever name its oldest fetched run happened to carry.
    return {
      groupKey,
      displayName: runs[0] !== undefined ? runDisplayName(runs[0]) : groupKey,
      runs,
    };
  });
  return groups.sort((a, b) =>
    (b.runs[0]?.createdAt ?? "").localeCompare(a.runs[0]?.createdAt ?? ""),
  );
}

export function computeInsightsStats(
  runs: readonly InsightsRun[],
  routines: readonly ScheduledWorkflowDefinition[],
  recentLimit: number = INSIGHTS_RECENT_LIMIT,
  now: number = Date.now(),
): InsightsStats {
  const purposeful = purposeRunsForInsights(runs);
  let running = 0;
  let errored = 0;
  let stopped = 0;
  let deployed = 0;
  for (const run of purposeful) {
    const outcome = runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
    switch (outcome) {
      case "running":
      case "updating":
        running += 1;
        break;
      case "error":
        errored += 1;
        break;
      case "stopped":
      case "completed":
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
    enabledRoutines: routines.filter((r) => r.status === "deployed").length,
    recentRuns,
  };
}
