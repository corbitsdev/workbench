// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import type { WorkflowRun } from "./api";
import type { RunTraceSpan } from "./insights-api";
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

/**
 * Keep runs whose `createdAt` falls inside `[fromIso, toIso]` (inclusive).
 * Invalid timestamps are dropped so KPIs never invent rows.
 */
export function filterRunsByCreatedAt(
  runs: readonly WorkflowRun[],
  fromIso: string,
  toIso: string,
): readonly WorkflowRun[] {
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
