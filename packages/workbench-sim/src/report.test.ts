import { describe, expect, test } from "bun:test";

import { renderReport, reportIsGreen, type RunReport } from "./report";

const report: RunReport = {
  scenarioName: "busy-team-week",
  description: "desc",
  mode: "noop",
  startedAt: "2026-08-17T00:00:00.000Z",
  labels: ["day 1", "day 2"],
  metrics: {
    messageCount: 110,
    threadReplyCount: 20,
    routineFireCount: 10,
    routineFiresAccepted: 10,
    dropCount: 0,
    threadViolations: [],
    latencyP50Ms: 12,
    latencyP95Ms: 40,
    dbRowGrowth: 350,
    wallClockMs: 90_000,
  },
  assertions: [
    { name: "message volume", pass: true, detail: "110 sent (needed >= 100)" },
  ],
};

describe("renderReport", () => {
  test("green report carries verdict, labels, and metrics", () => {
    expect(reportIsGreen(report)).toBe(true);
    const markdown = renderReport(report);
    expect(markdown).toContain("# Sim run: busy-team-week — GREEN");
    expect(markdown).toContain("day 1 -> day 2");
    expect(markdown).toContain("| send->persist p95 | 40ms |");
    expect(markdown).toContain("- PASS message volume");
  });

  test("any failing assertion flips the verdict", () => {
    const red: RunReport = {
      ...report,
      assertions: [{ name: "no drops", pass: false, detail: "3 missing" }],
    };
    expect(reportIsGreen(red)).toBe(false);
    expect(renderReport(red)).toContain("— RED");
    expect(renderReport(red)).toContain("- FAIL no drops: 3 missing");
  });
});
