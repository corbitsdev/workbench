// Client surface for packages/insights routes. Nulls mean "absent" —
// never coerce them to zero. Arktype schemas parse every trust boundary.
// Package contract (source of truth):
//   GET /usage → OverallUsageSummary
//   GET /activity → { days: DayActivity[] }
//   GET /tools → { tools: ToolCallSummary[] }
//   GET /runs/:runId/trace → RunTrace | { runId, spans: null, absent }

import { type } from "arktype";

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

export type OverallUsage = typeof OverallUsageSchema.infer;
export type DayActivity = typeof DayActivitySchema.infer;
export type ActivityResponse = typeof ActivityResponseSchema.infer;
export type ModelUsage = typeof ModelUsageSchema.infer;
export type ToolCall = typeof ToolCallSchema.infer;
export type ToolsResponse = typeof ToolsResponseSchema.infer;
export type RunTrace = typeof RunTraceSchema.infer;
export type RunTraceSpan = typeof RunTraceSpanSchema.infer;

/** Stable ISO from/to shared by usage, activity, and tools path builders. */
export type InsightsRange = {
  readonly from: string;
  readonly to: string;
};

/** Default Insights landing window (honest 7-day KPIs and charts). */
export const INSIGHTS_WINDOW_DAYS = 7;

/**
 * Build a fixed [from, to] window ending at `now`. Pass an explicit `now`
 * (and keep the result) so React query keys stay stable across rerenders.
 */
export function createInsightsWindow(
  days: number = INSIGHTS_WINDOW_DAYS,
  now: Date = new Date(),
): InsightsRange {
  const to = now.toISOString();
  const from = new Date(
    now.getTime() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { from, to };
}

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

/** Format USD cost; null stays an em-dash, never `$0.00`. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Compact integer; null/undefined → em-dash. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/** Rate 0–1 as percent; null → em-dash. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function tokensLabel(
  tokens: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly thinking: number;
  } | null,
): string | undefined {
  if (tokens === null) return undefined;
  const total =
    tokens.input +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.output +
    tokens.thinking;
  return `${total.toLocaleString()} tok`;
}

/** Models with tokens but no known rate (costUsd null). */
export function modelsWithMissingRates(usage: OverallUsage): readonly string[] {
  return usage.byModel
    .filter((m) => m.costUsd === null && m.tokens.total > 0)
    .map((m) => m.model);
}
