import { describe, expect, test } from "bun:test";
import type { EvalScore } from "./case";
import { buildScorecard, EvalScorecardSchema } from "./scorecard";

function score(
  caseId: string,
  passed: boolean,
  tools = 0,
): EvalScore {
  return {
    caseId,
    passed,
    constraints: [],
    trace: {
      caseId,
      systemPrompt: "s",
      advertisedTools: [],
      toolCalls: Array.from({ length: tools }, () => ({ name: "x" })),
      finalAnswer: "a",
      retries: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 100,
    },
  };
}

describe("buildScorecard", () => {
  test("computes pass rates and averages", () => {
    const card = buildScorecard({
      corpus: "v1",
      promptVersion: "3",
      model: "test-model",
      runs: [
        {
          caseId: "a",
          title: "A",
          scores: [score("a", true, 2), score("a", false, 0), score("a", true, 1)],
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(card.cases[0]?.passRate).toBeCloseTo(2 / 3);
    expect(card.cases[0]?.avgToolCalls).toBeCloseTo(1);
    expect(card.summary.passedRuns).toBe(2);
    expect(card.summary.failedRuns).toBe(1);
    const parsed = EvalScorecardSchema(card);
    expect(parsed instanceof Error).toBe(false);
  });

  test("throws on empty run list for a case", () => {
    expect(() =>
      buildScorecard({
        corpus: "v1",
        promptVersion: "3",
        model: "m",
        runs: [{ caseId: "a", title: "A", scores: [] }],
      }),
    ).toThrow(/zero scored runs/);
  });
});
