import { expect, test } from "bun:test";

import { renderResultsMarkdown } from "./report.ts";
import type { EvalRunResult } from "./types.ts";

test("renders an eval x config table with pass/fail/skip cells", () => {
  const results: EvalRunResult[] = [
    {
      evalName: "ai-daily-research",
      configName: "default",
      startedAt: "t0",
      finishedAt: "t1",
      steps: [
        {
          stepIndex: 0,
          turn: { human: "h", replyText: "r", toolCalls: [] },
          scorerReports: [
            {
              name: "asksQuestions",
              pass: true,
              score: 1,
              reason: "",
              stepIndex: 0,
            },
            {
              name: "judge",
              pass: true,
              score: 1,
              reason: "",
              skipped: true,
              stepIndex: 0,
            },
          ],
        },
      ],
    },
  ];
  const table = renderResultsMarkdown(
    ["ai-daily-research", "docs-on-sdk-change"],
    ["default"],
    results,
  );
  expect(table).toContain("| Eval | default |");
  expect(table).toContain("asksQuestions: PASS<br>judge: skip");
  expect(table).toContain("| docs-on-sdk-change | — |");
});

test("marks a failing scorer distinctly from a passing one", () => {
  const results: EvalRunResult[] = [
    {
      evalName: "c",
      configName: "cfg",
      startedAt: "t0",
      finishedAt: "t1",
      steps: [
        {
          stepIndex: 0,
          turn: { human: "h", replyText: "r", toolCalls: [] },
          scorerReports: [
            { name: "g", pass: false, score: 0, reason: "nope", stepIndex: 0 },
          ],
        },
      ],
    },
  ];
  const table = renderResultsMarkdown(["c"], ["cfg"], results);
  expect(table).toContain("g: FAIL");
});
