import { describe, expect, test } from "bun:test";

import { parseInsightsPath } from "./insights-path";

describe("parseInsightsPath", () => {
  test("resolves a workbench deep link", () => {
    expect(parseInsightsPath("/insights/workbench/tnt_1")).toEqual({
      mode: "workbench",
      runId: null,
      workbenchId: "tnt_1",
    });
  });

  test("resolves a run deep link", () => {
    expect(parseInsightsPath("/insights/runs/run_1")).toEqual({
      mode: "run",
      runId: "run_1",
      workbenchId: null,
    });
  });

  test("resolves the landing and runs-history paths", () => {
    expect(parseInsightsPath("/insights")).toEqual({
      mode: "landing",
      runId: null,
      workbenchId: null,
    });
    expect(parseInsightsPath("/insights/runs")).toEqual({
      mode: "runs",
      runId: null,
      workbenchId: null,
    });
  });

  test("a malformed escape on a workbench deep link falls back to landing, not a throw", () => {
    expect(() =>
      parseInsightsPath("/insights/workbench/%E0%A4%A"),
    ).not.toThrow();
    expect(parseInsightsPath("/insights/workbench/%E0%A4%A")).toEqual({
      mode: "landing",
      runId: null,
      workbenchId: null,
    });
  });

  test("a malformed escape on a run deep link falls back to landing, not a throw", () => {
    expect(() => parseInsightsPath("/insights/runs/%")).not.toThrow();
    expect(parseInsightsPath("/insights/runs/%")).toEqual({
      mode: "landing",
      runId: null,
      workbenchId: null,
    });
  });
});
