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

// Identity pass: the native `GET /workflows/runs` feed already excludes
// non-top-level runs, kept only for callers that still name it explicitly.
export function purposeRunsForInsights(runs: readonly InsightsRun[]): readonly InsightsRun[] {
  return runs;
}

// Falls back to definition name since the native feed carries no
// `routineName`; never mapped from a client-side lookup table.
export function runDisplayName(run: InsightsRun): string {
  return run.routineName ?? run.definitionName;
}

// Keeps runs whose `createdAt` falls inside `[fromIso, toIso]`; invalid
// timestamps are dropped so KPIs never invent rows.
export type DefinitionRunGroup = {
  /** `routineId` when set, else `definitionId` — kept distinct so two
   * routines sharing one definition never merge into one group. */
  readonly groupKey: string;
  readonly displayName: string;
  /** Newest run first. */
  readonly runs: readonly InsightsRun[];
};

// Client-side grouping of already-fetched runs, no new endpoint. Every
// group is definition-keyed today since the native feed lacks routine
// attribution; the routine branch rejoins once a fires equivalent exists.
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
