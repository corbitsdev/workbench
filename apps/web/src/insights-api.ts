// Client surface for packages/insights routes. Nulls mean "absent" —
// never coerce them to zero. Arktype schemas parse every trust boundary.

import { type } from "arktype";

export const TokenTotalsSchema = type({
  input: "number",
  cacheRead: "number",
  cacheWrite: "number",
  output: "number",
  thinking: "number",
  total: "number",
});

export const OverallUsageSchema = type({
  totalCostUsd: "number | null",
  totalTokens: TokenTotalsSchema,
  turnCount: "number",
  modelsWithMissingRates: "string[]",
});

export const DayActivitySchema = type({
  day: "string",
  turns: "number",
  tokens: "number",
  costUsd: "number | null",
});

export const ModelUsageSchema = type({
  model: "string",
  turnCount: "number",
  tokens: TokenTotalsSchema,
  costUsd: "number | null",
  ratesKnown: "boolean",
});

export const ToolCallSchema = type({
  tool: "string",
  calls: "number",
  successRate: "number | null",
});

export const RunTraceSpanSchema = type({
  id: "string",
  label: "string",
  kind: "string",
  startMs: "number",
  endMs: "number",
  tokens: type({
    input: "number",
    cacheRead: "number",
    cacheWrite: "number",
    output: "number",
    thinking: "number",
  }).or(type("null")),
  phase: "'ok' | 'awaiting' | 'failed'",
  "error?": "string",
});

export const RunTraceSchema = type({
  runId: "string",
  startedAt: "string",
  endedAt: "string | null",
  status: "string",
  totalCostUsd: "number | null",
  totalTokens: TokenTotalsSchema.or(type("null")),
  spans: RunTraceSpanSchema.array(),
});

export type OverallUsage = typeof OverallUsageSchema.infer;
export type DayActivity = typeof DayActivitySchema.infer;
export type ModelUsage = typeof ModelUsageSchema.infer;
export type ToolCall = typeof ToolCallSchema.infer;
export type RunTrace = typeof RunTraceSchema.infer;
export type RunTraceSpan = typeof RunTraceSpanSchema.infer;

export function insightsSummaryPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/insights/summary`;
}

export function insightsActivityPath(tenantId: string, days = 14): string {
  return `/api/tenants/${tenantId}/insights/activity?days=${days}`;
}

export function insightsByModelPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/insights/by-model`;
}

export function insightsByToolPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/insights/by-tool`;
}

export function insightsRunTracePath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/insights/runs/${encodeURIComponent(runId)}`;
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

/** Success rate 0–1 as percent; null → em-dash. */
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
