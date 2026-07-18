import { describe, expect, test } from "bun:test";
import { V1_EVAL_CASES } from "./fixtures";
import {
  composeStubEvalPrompt,
  createFailingScriptedAdapter,
  createPassingScriptedAdapter,
  runEvalCase,
} from "./runner";
import { buildScorecard, formatScorecardMarkdown } from "./scorecard";

describe("runEvalCase", () => {
  test("scripted pass adapter clears every v1 case", async () => {
    const adapter = createPassingScriptedAdapter();
    for (const c of V1_EVAL_CASES) {
      const result = await runEvalCase(c, adapter, {
        composePrompt: composeStubEvalPrompt,
      });
      expect(result.score.passed).toBe(true);
      expect(result.trace.systemPrompt.length).toBeGreaterThan(0);
      expect(result.advertisedTools.length).toBeGreaterThan(0);
      expect(result.systemPrompt).toContain("Myra");
    }
  });

  test("scripted fail adapter fails closed on constrained cases", async () => {
    const adapter = createFailingScriptedAdapter();
    const constrained = V1_EVAL_CASES.filter(
      (c) =>
        (c.constraints.mustNotCallTools?.length ?? 0) > 0 ||
        c.constraints.forbidFalseCompletion === true,
    );
    expect(constrained.length).toBeGreaterThan(0);
    for (const c of constrained) {
      const result = await runEvalCase(c, adapter);
      expect(result.score.passed).toBe(false);
    }
  });

  test("captured trace records case id and usage", async () => {
    const c = V1_EVAL_CASES[0];
    if (c === undefined) throw new Error("empty corpus");
    const result = await runEvalCase(c, createPassingScriptedAdapter());
    expect(result.trace.caseId).toBe(c.id);
    expect(result.trace.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(result.trace.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("buildScorecard", () => {
  test("aggregates multi-run results into a markdown report", async () => {
    const adapter = createPassingScriptedAdapter();
    const runs = [];
    for (const c of V1_EVAL_CASES) {
      const scores = [];
      for (let i = 0; i < 3; i++) {
        scores.push((await runEvalCase(c, adapter)).score);
      }
      runs.push({ caseId: c.id, title: c.title, scores });
    }
    const card = buildScorecard({
      corpus: "v1",
      promptVersion: "stub",
      model: "scripted-pass",
      runs,
    });
    expect(card.summary.totalCases).toBe(V1_EVAL_CASES.length);
    expect(card.summary.totalRuns).toBe(V1_EVAL_CASES.length * 3);
    expect(card.summary.passRate).toBe(1);
    expect(card.runsPerCase).toBe(3);
    const md = formatScorecardMarkdown(card);
    expect(md).toContain("Myra eval scorecard");
    expect(md).toContain("greeting-no-tool");
  });
});
