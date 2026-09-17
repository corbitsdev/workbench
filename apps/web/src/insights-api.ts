// This app's fetch/query plumbing over packages/insights routes: arktype
// schemas that parse every trust boundary, and the path builders for this
// app's tenant-scoped insights routes. Pure domain formatting/windowing
// (formatUsd, activitySeriesForWindow, EMPTY_OVERALL_USAGE, etc.) lives in
// @corbits/insights/client — browser-safe and shared with any UI over this
// data, not tied to this app's routes.
//   GET /usage → OverallUsageSummary
//   GET /activity → { days: DayActivity[] }
//   GET /tools → { tools: ToolCallSummary[] }
//   GET /runs/:runId/trace → RunTrace | { runId, spans: null, absent }
//   GET /scope → InsightsScope — own identity, parent (if any), sibling
//     workbenches. usage/activity/tools roll up automatically when called
//     with a parent's tenantId (see @corbits/insights' resolveScope) —
//     /scope is how a page discovers that shape to build a switcher.
// Plus one more reused as Insights' run feed: the native tenant-scoped
// `GET /workflows/runs` top-level listing → Paginated<WorkflowRunResponse>
// (CL-8087 deleted `@corbits/run-scope`'s `/top-level-runs?feed=fires`,
// which used to attribute each fire to its routine server-side).

import { type } from "arktype";
import { WorkflowRunResponse, paginatedSchema } from "@intx/types";

import type { InsightsRange } from "@corbits/insights/client";

export const TokenTotalsSchema = type({
  input: "number",
  cacheRead: "number",
  cacheWrite: "number",
  output: "number",
  thinking: "number",
  total: "number",
});

export const ModelUsageSchema = type({
  model: "string",
  turns: "number",
  tokens: TokenTotalsSchema,
  costUsd: "number | null",
});

/** GET /usage body — OverallUsageSummary from packages/insights. */
export const OverallUsageSchema = type({
  turns: "number",
  tokens: TokenTotalsSchema,
  costUsd: "number | null",
  byModel: ModelUsageSchema.array(),
});

export const ModelDayUsageSchema = type({
  model: "string",
  tokens: "number",
  costUsd: "number | null",
});

export const DayActivitySchema = type({
  day: "string",
  turns: "number",
  tokens: "number",
  byModel: ModelDayUsageSchema.array(),
});

/** GET /activity envelope. */
export const ActivityResponseSchema = type({
  days: DayActivitySchema.array(),
});

/** One workbench's usage totals — GET /workbenches item. */
export const WorkbenchUsageSchema = type({
  tenantId: "string",
  name: "string",
  turns: "number",
  tokens: TokenTotalsSchema,
  costUsd: "number | null",
});

/** GET /workbenches envelope. */
export const WorkbenchesResponseSchema = type({
  items: WorkbenchUsageSchema.array(),
});

export type WorkbenchUsage = typeof WorkbenchUsageSchema.infer;

export function insightsWorkbenchesPath(
  tenantId: string,
  range: InsightsRange,
): string {
  return withInsightsRange(
    `/api/tenants/${tenantId}/insights/workbenches`,
    range,
  );
}

/** p50/p95 (ms) over one turn stage, or null samples/values when that
 * stage recorded nothing in range (see @corbits/insights' LatencyStageStat). */
export const LatencyStageStatSchema = type({
  p50Ms: "number | null",
  p95Ms: "number | null",
  samples: "number",
});

/** GET /latency body — LatencySummary from packages/insights. */
export const LatencySummarySchema = type({
  toReactorStart: LatencyStageStatSchema,
  toInferenceStart: LatencyStageStatSchema,
  toFirstToken: LatencyStageStatSchema,
  toReplyPosted: LatencyStageStatSchema,
  total: LatencyStageStatSchema,
});

export type LatencySummary = typeof LatencySummarySchema.infer;

export function insightsLatencyPath(
  tenantId: string,
  range: InsightsRange,
): string {
  return withInsightsRange(`/api/tenants/${tenantId}/insights/latency`, range);
}

export const ToolCallSchema = type({
  tool: "string",
  calls: "number",
  errors: "number",
  errorRate: "number | null",
});

/** GET /tools envelope. */
export const ToolsResponseSchema = type({
  tools: ToolCallSchema.array(),
});

export const RunTraceSpanSchema = type({
  id: "string",
  label: "string",
  kind: "string",
  start: "number",
  end: "number",
  durationMs: "number | null",
  tokens: type({
    input: "number",
    cacheRead: "number",
    cacheWrite: "number",
    output: "number",
    thinking: "number",
  }).or(type("null")),
  phase: "'ok' | 'awaiting' | 'failed'",
  error: "string | null",
  timingSource: "'measured' | 'ordinal'",
});

/** Present run trace (reader mounted and run found). */
export const RunTracePresentSchema = type({
  runId: "string",
  spans: RunTraceSpanSchema.array(),
});

/** Explicit absent when no run-trace reader is mounted. */
export const RunTraceAbsentSchema = type({
  runId: "string",
  spans: "null",
  absent: "string",
});

export const RunTraceSchema = RunTracePresentSchema.or(RunTraceAbsentSchema);

export type ActivityResponse = typeof ActivityResponseSchema.infer;
export type ToolCall = typeof ToolCallSchema.infer;
export type ToolsResponse = typeof ToolsResponseSchema.infer;
export type RunTrace = typeof RunTraceSchema.infer;
export type RunTraceSpan = typeof RunTraceSpanSchema.infer;

function withInsightsRange(path: string, range: InsightsRange): string {
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
  });
  return `${path}?${params.toString()}`;
}

export function insightsUsagePath(
  tenantId: string,
  range: InsightsRange,
): string {
  return withInsightsRange(`/api/tenants/${tenantId}/insights/usage`, range);
}

export function insightsActivityPath(
  tenantId: string,
  range: InsightsRange,
): string {
  return withInsightsRange(`/api/tenants/${tenantId}/insights/activity`, range);
}

export function insightsToolsPath(
  tenantId: string,
  range: InsightsRange,
): string {
  return withInsightsRange(`/api/tenants/${tenantId}/insights/tools`, range);
}

export function insightsRunTracePath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/insights/runs/${encodeURIComponent(runId)}/trace`;
}

export const InsightsScopeTenantSchema = type({
  tenantId: "string",
  name: "string",
});

/**
 * GET /scope body — the current workbench's own identity, its parent (a
 * workspace, when this workbench was created under one — null for a
 * root workbench with no parent), and the sibling workbenches to switch
 * between (just itself when there is no parent).
 */
export const InsightsScopeSchema = type({
  tenantId: "string",
  name: "string",
  parent: InsightsScopeTenantSchema.or(type("null")),
  workbenches: InsightsScopeTenantSchema.array(),
});

export type InsightsScope = typeof InsightsScopeSchema.infer;

export function insightsScopePath(tenantId: string): string {
  return `/api/tenants/${tenantId}/insights/scope`;
}

export const ListingTurnSchema = type({
  status: "string",
  "endedAt?": "string | null",
});

/**
 * `WorkflowRunResponse` plus the two routine-attribution fields the deleted
 * `feed=fires` mode of `/top-level-runs` used to report (CL-6249): the
 * routine that fired this run, when it has one. The native
 * `GET /workflows/runs` listing has no routine attribution, so both are
 * absent there — callers fall back to `definitionId`/`definitionName`
 * (`groupRunsByDefinition`, `runDisplayName` in `./insights-stats.ts`)
 * instead of inventing a routine. Both stay `null` (when present) for a
 * run with no routine/task parent — a directly launched workflow.
 * `turns` / `hasInFlightTurn` are this build's listing of in-flight
 * inference turns for the run (not Interchange fields) so a live
 * tool-loop can stay running past the abandoned-fire window. Omitting
 * them is not "no in-flight turn".
 */
export const InsightsRunSchema = WorkflowRunResponse.and(
  type({
    "routineId?": "string | null",
    "routineName?": "string | null",
    "hasInFlightTurn?": "boolean",
    "turns?": ListingTurnSchema.array(),
  }),
);
export type InsightsRun = typeof InsightsRunSchema.infer;

/** Native `GET /workflows/runs` envelope (CL-8087). */
export const TopLevelRunsSchema = paginatedSchema(InsightsRunSchema);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`) —
// same limit `agents-api.ts`'s `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

/**
 * Insights' run feed (CL-6062; repointed to native in CL-8087): the
 * tenant's top-level runs from `GET /workflows/runs` — the native
 * listing's own predicate (`address IS NOT NULL AND anchorRunId = id`,
 * see `vendor/intx/hub-api/src/routes/runs.ts`) already excludes every
 * non-top-level run (workbench host, invited agent), so this page never
 * derives that exclusion itself. Four differences from the deleted
 * `feed=fires` feed, all recorded as accepted loss in CL-8087: a
 * routine's fire (not a top-level run) is no longer included, so
 * Insights no longer sees routine executions; there is no routine
 * attribution, so history groups by definition; the resident,
 * never-triggered deployment placeholder (`status: "deployed"`) is now
 * included — `computeInsightsStats` counts it as deployed rather than
 * hiding it; and the feed is single-tenant — the deleted route expanded
 * the requested tenant to its whole descendant subtree via
 * `getDescendantTenants` (the same rollup `resolveScope` still gives
 * `/usage`, `/activity`, and `/tools`), while the native listing filters
 * `tenantId = requested tenant` only, so a workspace parent's runs feed
 * no longer rolls up its child workbenches and now sits mismatched
 * against its own usage aggregate. Used in place of the dead
 * `/me/workflows/runs` — its `anchorRunId IS NULL` filter never matches,
 * because every addressed run self-anchors at creation, so that feed
 * always came back empty.
 */
export function insightsTopLevelRunsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs?limit=${TOP_LEVEL_RUNS_LIMIT}`;
}
