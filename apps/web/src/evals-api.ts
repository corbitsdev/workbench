// This app's fetch/query plumbing over packages/evals routes (CL-6465):
// arktype schemas that parse every trust boundary, and the path builders
// for this app's tenant-scoped eval-run routes. Same split as
// insights-api.ts — pure wire shapes and paths here, page logic in
// pages/evals-page.tsx.
//   GET /eval-runs/runs               → { runs: EvalRunSummary[] }
//   GET /eval-runs/runs/:runId        → EvalRunDetail
//
// Eval runs aren't tenant-owned (packages/evals/src/routes.ts's own
// header comment) — the tenant id in the path is only the grant gate,
// same as insights' non-partitioned reads.

import { type } from "arktype";

const ScorerReportSchema = type({
  name: "string",
  score: "number",
  pass: "boolean",
  reason: "string",
  "skipped?": "boolean",
});

const ToolCallSchema = type({
  name: "string",
  arguments: "object",
  isError: "boolean",
  result: "string",
});

const TurnSchema = type({
  human: "string",
  replyText: "string",
  toolCalls: ToolCallSchema.array(),
});

const EvalStepRecordSchema = type({
  stepIndex: "number",
  turn: TurnSchema,
  scorerReports: ScorerReportSchema.array(),
});

const ScorerTallySchema = type({
  passed: "number",
  failed: "number",
  skipped: "number",
});

export const EvalRunSummarySchema = type({
  id: "string",
  evalName: "string",
  evalDescription: "string | null",
  configName: "string",
  startedAt: "string",
  finishedAt: "string",
  stepCount: "number",
  scorerTally: ScorerTallySchema,
});

export const EvalRunsResponseSchema = type({
  runs: EvalRunSummarySchema.array(),
});

export const EvalRunDetailSchema = type({
  id: "string",
  evalName: "string",
  evalDescription: "string | null",
  configName: "string",
  startedAt: "string",
  finishedAt: "string",
  steps: EvalStepRecordSchema.array(),
});

export type ScorerReport = typeof ScorerReportSchema.infer;
export type ToolCall = typeof ToolCallSchema.infer;
export type EvalStepRecord = typeof EvalStepRecordSchema.infer;
export type EvalRunSummary = typeof EvalRunSummarySchema.infer;
export type EvalRunDetail = typeof EvalRunDetailSchema.infer;

const EVAL_RUNS_LIMIT = 50;

export function evalRunsPath(
  tenantId: string,
  evalName: string | null,
): string {
  const params = new URLSearchParams({ limit: String(EVAL_RUNS_LIMIT) });
  if (evalName !== null) params.set("evalName", evalName);
  return `/api/tenants/${encodeURIComponent(tenantId)}/eval-runs/runs?${params.toString()}`;
}

export function evalRunPath(tenantId: string, runId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/eval-runs/runs/${encodeURIComponent(runId)}`;
}

/** Passed only when every scorer that actually ran passed — a run with
 * zero recorded scorer calls (a step with no `expect`) is not a failure,
 * so this only ever flips to "failed" on a genuine failed report. */
export function evalRunOutcome(
  tally: EvalRunSummary["scorerTally"],
): "passed" | "failed" {
  return tally.failed > 0 ? "failed" : "passed";
}

export function evalRunDurationMs(run: {
  readonly startedAt: string;
  readonly finishedAt: string;
}): number | null {
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
