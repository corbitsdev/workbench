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
// Plus two tenant-scoped routes outside `/insights`, reused for chain
// context on a run's detail view (packages/tasks/src/routes.ts):
//   GET /tasks/by-run/:runId → { item: Task } | 404 (run has no owning task)
//   GET /tasks/:id/legs → { items: TaskLeg[] } in position order
// and one more reused as Insights' run feed: GET /top-level-runs →
// Paginated<WorkflowRunResponse> (packages/folded-runs/src/scope-routes.ts).

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

export const DayActivitySchema = type({
  day: "string",
  turns: "number",
  tokens: "number",
});

/** GET /activity envelope. */
export const ActivityResponseSchema = type({
  days: DayActivitySchema.array(),
});

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

/** GET /tasks/:id/legs item — one step of a chained task. */
export const TaskLegSchema = type({
  position: "number",
  definitionId: "string",
  prompt: "string",
  status: "'pending' | 'dispatching' | 'running' | 'done' | 'failed'",
  runId: "string | null",
  startedAt: "string | null",
  settledAt: "string | null",
});

/** GET /tasks/:id/legs envelope. */
export const TaskLegsResponseSchema = type({
  items: TaskLegSchema.array(),
});

/** GET /tasks/:id and GET /tasks/by-run/:runId item — the chain a run
 * belongs to, when it belongs to one. */
export const TaskSchema = type({
  id: "string",
  definitionId: "string",
  agentName: "string",
  prompt: "string",
  status: "string",
  runId: "string",
  runIds: "string[]",
  stepCount: "number",
});

/** GET /tasks/by-run/:runId and GET /tasks/:id envelope. */
export const TaskResponseSchema = type({
  item: TaskSchema,
});

export type TaskLeg = typeof TaskLegSchema.infer;
export type Task = typeof TaskSchema.infer;

export function insightsTaskByRunPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/tasks/by-run/${encodeURIComponent(runId)}`;
}

export function insightsTaskLegsPath(tenantId: string, taskId: string): string {
  return `/api/tenants/${tenantId}/tasks/${encodeURIComponent(taskId)}/legs`;
}

export type InsightsRun = typeof WorkflowRunResponse.infer;

/** GET /top-level-runs envelope. */
export const TopLevelRunsSchema = paginatedSchema(WorkflowRunResponse);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`) —
// same limit `agents-api.ts`'s `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

/**
 * Insights' run feed (CL-6062): the tenant's genuine top-level deployment
 * runs, every folded run (channel host, invited agent, task) already
 * excluded server-side by `@corbits/folded-runs`'s `scope-routes.ts`. Used
 * in place of the dead `/me/workflows/runs` — its `anchorRunId IS NULL`
 * filter never matches, because every addressed run self-anchors at
 * creation, so that feed always came back empty.
 */
export function insightsTopLevelRunsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/top-level-runs?limit=${TOP_LEVEL_RUNS_LIMIT}`;
}
