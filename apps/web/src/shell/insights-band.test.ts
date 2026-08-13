import { describe, expect, test } from "bun:test";

import { insightsPathForView, insightsViewFromPath } from "./insights-band";

describe("insightsViewFromPath", () => {
  test("/insights resolves to the overview view", () => {
    expect(insightsViewFromPath("/insights")).toBe("overview");
  });

  test("/insights/runs resolves to the runs view", () => {
    expect(insightsViewFromPath("/insights/runs")).toBe("runs");
  });

  test("a run detail path keeps the runs view active", () => {
    expect(insightsViewFromPath("/insights/runs/run_123")).toBe("runs");
  });
});

describe("insightsPathForView", () => {
  test("maps each view back to its path", () => {
    expect(insightsPathForView("overview")).toBe("/insights");
    expect(insightsPathForView("runs")).toBe("/insights/runs");
  });
});
