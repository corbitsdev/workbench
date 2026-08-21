import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  evalRunDurationMs,
  evalRunOutcome,
  evalRunPath,
  evalRunsPath,
  EvalRunDetailSchema,
  EvalRunsResponseSchema,
} from "./evals-api";

describe("evalRunOutcome", () => {
  test("a run with a failed scorer is failed", () => {
    expect(evalRunOutcome({ passed: 2, failed: 1, skipped: 0 })).toBe("failed");
  });

  test("a run with only passes and skips is passed", () => {
    expect(evalRunOutcome({ passed: 3, failed: 0, skipped: 1 })).toBe("passed");
  });

  test("a run with no scorer calls at all is passed, not falsely failed", () => {
    expect(evalRunOutcome({ passed: 0, failed: 0, skipped: 0 })).toBe("passed");
  });
});

describe("evalRunDurationMs", () => {
  test("computes the wall-clock span", () => {
    expect(
      evalRunDurationMs({
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
      }),
    ).toBe(5000);
  });

  test("returns null for an unparsable timestamp instead of NaN", () => {
    expect(
      evalRunDurationMs({ startedAt: "not-a-date", finishedAt: "also-not" }),
    ).toBeNull();
  });
});

describe("path builders", () => {
  test("evalRunsPath carries a limit and an optional eval-name filter", () => {
    expect(evalRunsPath("tnt_1", null)).toBe(
      "/api/tenants/tnt_1/eval-runs/runs?limit=50",
    );
    expect(evalRunsPath("tnt_1", "factory")).toBe(
      "/api/tenants/tnt_1/eval-runs/runs?limit=50&evalName=factory",
    );
  });

  test("evalRunPath addresses one run by its opaque store id", () => {
    expect(evalRunPath("tnt_1", "evalrun_1")).toBe(
      "/api/tenants/tnt_1/eval-runs/runs/evalrun_1",
    );
  });
});

describe("wire schemas", () => {
  test("parses a real list envelope", () => {
    const parsed = EvalRunsResponseSchema({
      runs: [
        {
          id: "evalrun_1",
          evalName: "factory",
          evalDescription: "The factory eval",
          configName: "default",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:02:00.000Z",
          stepCount: 3,
          scorerTally: { passed: 3, failed: 0, skipped: 0 },
        },
      ],
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  test("parses a real run detail envelope with tool calls and scorer reports", () => {
    const parsed = EvalRunDetailSchema({
      id: "evalrun_1",
      evalName: "factory",
      evalDescription: null,
      configName: "default",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
      steps: [
        {
          stepIndex: 0,
          turn: {
            human: "hello",
            replyText: "hi",
            toolCalls: [
              {
                name: "list_issues",
                arguments: { team: "Corbits" },
                isError: false,
                result: "[]",
              },
            ],
          },
          scorerReports: [
            {
              name: "mentions-issues",
              score: 1,
              pass: true,
              reason: "found the word",
            },
          ],
        },
      ],
    });
    expect(parsed instanceof type.errors).toBe(false);
  });
});
