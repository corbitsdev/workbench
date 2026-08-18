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
// Plus two tenant-scoped routes outside `/insights`, reused for chain
// context on a run's detail view (packages/tasks/src/routes.ts):
//   GET /tasks/by-run/:runId → { item: Task } | 404 (run has no owning task)
//   GET /tasks/:id/legs → { items: TaskLeg[] } in position order
// and one more reused as Insights' run feed: GET /top-level-runs?feed=fires
// → Paginated<WorkflowRunResponse & { routineId, routineName }>
// (packages/folded-runs/src/scope-routes.ts's `listTopLevelRunFires`).

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

/**
 * `WorkflowRunResponse` plus the two fields only the `feed=fires` mode of
 * `/top-level-runs` reports (CL-6249): the routine that fired this run,
 * when it has one. Both are `null` for a run with no routine/task
 * parent — a directly launched workflow — so a caller falls back to
 * `definitionName` honestly instead of inventing a routine.
 */
export const InsightsRunSchema = WorkflowRunResponse.and(
  type({
    routineId: "string | null",
    routineName: "string | null",
  }),
);
export type InsightsRun = typeof InsightsRunSchema.infer;

/** GET /top-level-runs?feed=fires envelope. */
export const TopLevelRunsSchema = paginatedSchema(InsightsRunSchema);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`) —
// same limit `agents-api.ts`'s `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

/**
 * Insights' run feed (CL-6062, `feed=fires` added by CL-6249): the
 * tenant's genuine *executed* runs — a routine's fire (folded run though
 * it is) included, and the resident, never-triggered deployment
 * placeholder for a definition (`status: "deployed"` forever) excluded —
 * both decided server-side by `@corbits/folded-runs`'s
 * `scope-routes.ts`'s `listTopLevelRunFires`, never by a definitionName
 * slug guess here. Used in place of the dead `/me/workflows/runs` — its
 * `anchorRunId IS NULL` filter never matches, because every addressed run
 * self-anchors at creation, so that feed always came back empty.
 */
export function insightsTopLevelRunsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/top-level-runs?limit=${TOP_LEVEL_RUNS_LIMIT}&feed=fires`;
}
