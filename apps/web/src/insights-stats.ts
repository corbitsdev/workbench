// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";
import type { BadgeTone } from "@corbits/react-ui";

import type { InsightsRun, RunTraceSpan, TaskLeg } from "./insights-api";
import type { Routine } from "./routines-api";

export type TraceStats = {
  readonly steps: number;
  readonly completed: number;
  readonly failed: number;
  readonly durationMs: number;
};

/**
 * Run-detail stat strip (steps/completed/failed/duration) is derived from
 * the trace's own spans — never fabricated when the trace is absent or
 * empty. Returns null when there is nothing to derive from.
 */
export function computeTraceStats(
  spans: readonly RunTraceSpan[] | null,
): TraceStats | null {
  if (spans === null || spans.length === 0) return null;
  let completed = 0;
  let failed = 0;
  for (const span of spans) {
    if (span.phase === "ok") completed += 1;
    if (span.phase === "failed") failed += 1;
  }
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  return {
    steps: spans.length,
    completed,
    failed,
    durationMs: Math.max(0, end - start),
  };
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
 * Purpose runs only — drop channel-host anchors the same way Home does.
 * `insights-page.tsx` sources `runs` from `insightsTopLevelRunsPath` (see
 * `./insights-api.ts`), which already excludes every folded run (channel
 * host, invited agent, task) server-side via `@corbits/folded-runs`'s
 * `scope-routes.ts`. This filter is a client-side belt-and-suspenders pass
 * against the channel-host naming pattern alone, not a second scoping
 * layer — a caller no longer needs to (and cannot) hand this a folded-run
 * id set. CL-6062 replaced the dead `/me/workflows/runs` feed (its
 * `anchorRunId IS NULL` filter never matched anything, since every
 * addressed run self-anchors at creation) with this scoped one.
 */
export function purposeRunsForInsights(
  runs: readonly InsightsRun[],
): readonly InsightsRun[] {
  return runs.filter((run) => !isChannelHostDefinitionName(run.definitionName));
}

/**
 * Keep runs whose `createdAt` falls inside `[fromIso, toIso]` (inclusive).
 * Invalid timestamps are dropped so KPIs never invent rows.
 */
export type DefinitionRunGroup = {
  readonly definitionId: string;
  readonly definitionName: string;
  /** Newest run first. */
  readonly runs: readonly InsightsRun[];
};

/**
 * "Run history" grouping for the Insights runs page: the same feed already
 * fetched for the flat list, bucketed by definition and sorted newest-run
 * first — a client-side grouping of already-fetched data, no new endpoint.
 * Group order follows each group's own newest run, newest overall first.
 */
export function groupRunsByDefinition(
  runs: readonly InsightsRun[],
): readonly DefinitionRunGroup[] {
  const byDefinition = new Map<string, InsightsRun[]>();
  for (const run of runs) {
    const bucket = byDefinition.get(run.definitionId);
    if (bucket === undefined) {
      byDefinition.set(run.definitionId, [run]);
    } else {
      bucket.push(run);
    }
  }
  const groups = [...byDefinition.entries()].map(([definitionId, group]) => ({
    definitionId,
    definitionName: group[0]?.definitionName ?? definitionId,
    runs: [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }));
  return groups.sort((a, b) =>
    (b.runs[0]?.createdAt ?? "").localeCompare(a.runs[0]?.createdAt ?? ""),
  );
}

/** Duration of a settled leg in milliseconds, or null while it is still
 * pending, dispatching, or running — never a fabricated in-flight number. */
export function legDurationMs(leg: TaskLeg): number | null {
  if (leg.startedAt === null || leg.settledAt === null) return null;
  const startMs = Date.parse(leg.startedAt);
  const endMs = Date.parse(leg.settledAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

/** Badge tone for a chain step, matching the run-status palette used
 * elsewhere on Insights (`statusTone` in `pages/insights-page.tsx`). */
export function legStatusTone(status: TaskLeg["status"]): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "dispatching":
    case "running":
      return "info";
    case "failed":
      return "danger";
    case "pending":
      return "neutral";
  }
}

export function filterRunsByCreatedAt(
  runs: readonly InsightsRun[],
  fromIso: string,
  toIso: string,
): readonly InsightsRun[] {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return [];
  return runs.filter((run) => {
    const t = Date.parse(run.createdAt);
    if (Number.isNaN(t)) return false;
    return t >= fromMs && t <= toMs;
  });
}

export function computeInsightsStats(
  runs: readonly InsightsRun[],
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
