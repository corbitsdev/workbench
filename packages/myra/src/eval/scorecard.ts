import { type } from "arktype";
import type { EvalScore } from "./case";

export const EvalScorecardSchema = type({
  corpus: "string",
  promptVersion: "string",
  model: "string",
  runsPerCase: "number.integer >= 1",
  generatedAt: "string",
  cases: type({
    caseId: "string",
    title: "string",
    passCount: "number.integer >= 0",
    failCount: "number.integer >= 0",
    passRate: "number",
    avgToolCalls: "number",
    avgRetries: "number",
    avgLatencyMs: "number",
    avgInputTokens: "number",
    avgOutputTokens: "number",
    falseCompletionCount: "number.integer >= 0",
  }).array(),
  summary: {
    totalCases: "number.integer >= 0",
    totalRuns: "number.integer >= 0",
    passedRuns: "number.integer >= 0",
    failedRuns: "number.integer >= 0",
    passRate: "number",
    falseCompletionRuns: "number.integer >= 0",
  },
});
export type EvalScorecard = typeof EvalScorecardSchema.infer;

export type ScorecardRun = {
  caseId: string;
  title: string;
  scores: EvalScore[];
};

/**
 * Aggregate per-case multi-run scores into a baseline scorecard.
 */
export function buildScorecard(opts: {
  corpus: string;
  promptVersion: string;
  model: string;
  runs: ScorecardRun[];
  generatedAt?: string;
}): EvalScorecard {
  const cases = opts.runs.map((run) => {
    const n = run.scores.length;
    if (n === 0) {
      throw new Error(
        `buildScorecard: case "${run.caseId}" has zero scored runs`,
      );
    }
    const passCount = run.scores.filter((s) => s.passed).length;
    const failCount = n - passCount;
    const sum = (fn: (s: EvalScore) => number) =>
      run.scores.reduce((acc, s) => acc + fn(s), 0);
    return {
      caseId: run.caseId,
      title: run.title,
      passCount,
      failCount,
      passRate: passCount / n,
      avgToolCalls: sum((s) => s.trace.toolCalls.length) / n,
      avgRetries: sum((s) => s.trace.retries) / n,
      avgLatencyMs: sum((s) => s.trace.latencyMs) / n,
      avgInputTokens: sum((s) => s.trace.usage.inputTokens) / n,
      avgOutputTokens: sum((s) => s.trace.usage.outputTokens) / n,
      falseCompletionCount: run.scores.filter(
        (s) => s.trace.falseCompletion === true,
      ).length,
    };
  });

  const totalRuns = cases.reduce((a, c) => a + c.passCount + c.failCount, 0);
  const passedRuns = cases.reduce((a, c) => a + c.passCount, 0);
  const falseCompletionRuns = cases.reduce(
    (a, c) => a + c.falseCompletionCount,
    0,
  );

  return {
    corpus: opts.corpus,
    promptVersion: opts.promptVersion,
    model: opts.model,
    runsPerCase:
      opts.runs[0] !== undefined ? opts.runs[0].scores.length : 0,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    cases,
    summary: {
      totalCases: cases.length,
      totalRuns,
      passedRuns,
      failedRuns: totalRuns - passedRuns,
      passRate: totalRuns === 0 ? 0 : passedRuns / totalRuns,
      falseCompletionRuns,
    },
  };
}

export function formatScorecardMarkdown(card: EvalScorecard): string {
  const lines: string[] = [
    `# Myra eval scorecard — ${card.corpus}`,
    "",
    `- Prompt version: \`${card.promptVersion}\``,
    `- Model: \`${card.model}\``,
    `- Runs per case: ${card.runsPerCase}`,
    `- Generated: ${card.generatedAt}`,
    `- Pass rate: ${(card.summary.passRate * 100).toFixed(1)}% (${card.summary.passedRuns}/${card.summary.totalRuns})`,
    `- False completions: ${card.summary.falseCompletionRuns}`,
    "",
    "| Case | Pass rate | Avg tools | Avg latency (ms) | In/out tokens |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const c of card.cases) {
    lines.push(
      `| ${c.caseId} | ${(c.passRate * 100).toFixed(0)}% (${c.passCount}/${c.passCount + c.failCount}) | ${c.avgToolCalls.toFixed(1)} | ${c.avgLatencyMs.toFixed(0)} | ${c.avgInputTokens.toFixed(0)}/${c.avgOutputTokens.toFixed(0)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
