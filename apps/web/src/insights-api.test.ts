import { describe, expect, test } from "bun:test";

import {
  activitySeriesForWindow,
  createInsightsWindow,
  EMPTY_OVERALL_USAGE,
  formatCount,
  formatUsd,
  INSIGHTS_WINDOW_DAYS,
  insightsActivityPath,
  insightsToolsPath,
  insightsUsagePath,
} from "./insights-api";

// Fixed clock so range math is deterministic regardless of suite time.
const NOW = new Date("2026-01-15T18:00:00.000Z");

describe("createInsightsWindow", () => {
  test("defaults to a 7-day window ending at now", () => {
    const range = createInsightsWindow(undefined, NOW);
    expect(INSIGHTS_WINDOW_DAYS).toBe(7);
    expect(range.to).toBe("2026-01-15T18:00:00.000Z");
    expect(range.from).toBe("2026-01-08T18:00:00.000Z");
  });

  test("is stable for the same now input", () => {
    expect(createInsightsWindow(7, NOW)).toEqual(createInsightsWindow(7, NOW));
  });
});

describe("empty usage defaults", () => {
  test("EMPTY_OVERALL_USAGE is zero metrics, not null cost", () => {
    expect(EMPTY_OVERALL_USAGE.turns).toBe(0);
    expect(EMPTY_OVERALL_USAGE.costUsd).toBe(0);
    expect(EMPTY_OVERALL_USAGE.byModel).toEqual([]);
    expect(EMPTY_OVERALL_USAGE.tokens).toEqual({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      thinking: 0,
      total: 0,
    });
    // Formatters must render zeros, never em-dash / NaN for empty spend.
    expect(formatUsd(EMPTY_OVERALL_USAGE.costUsd)).toBe("$0.00");
    expect(formatCount(EMPTY_OVERALL_USAGE.turns)).toBe("0");
    expect(formatCount(EMPTY_OVERALL_USAGE.tokens.total)).toBe("0");
  });

  test("activitySeriesForWindow pads empty sink to zero day series", () => {
    const range = createInsightsWindow(INSIGHTS_WINDOW_DAYS, NOW);
    const series = activitySeriesForWindow([], range);
    expect(series).toHaveLength(INSIGHTS_WINDOW_DAYS);
    expect(series.every((d) => d.turns === 0 && d.tokens === 0)).toBe(true);
    expect(series.map((d) => d.day)).toEqual([
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
    ]);
  });

  test("activitySeriesForWindow preserves nonzero day counts", () => {
    const range = createInsightsWindow(INSIGHTS_WINDOW_DAYS, NOW);
    const series = activitySeriesForWindow(
      [
        { day: "2026-01-14", turns: 3, tokens: 900 },
        { day: "2026-01-15", turns: 1, tokens: 100 },
      ],
      range,
    );
    expect(series).toHaveLength(7);
    expect(series.find((d) => d.day === "2026-01-14")).toEqual({
      day: "2026-01-14",
      turns: 3,
      tokens: 900,
    });
    expect(series.find((d) => d.day === "2026-01-15")).toEqual({
      day: "2026-01-15",
      turns: 1,
      tokens: 100,
    });
    expect(series.find((d) => d.day === "2026-01-10")?.turns).toBe(0);
  });

  test("formatUsd keeps em-dash for unknown rates, not for zero", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("insights path range contract", () => {
  test("usage, activity, and tools share the same from/to", () => {
    const range = createInsightsWindow(INSIGHTS_WINDOW_DAYS, NOW);
    const usage = insightsUsagePath("tenant-1", range);
    const activity = insightsActivityPath("tenant-1", range);
    const tools = insightsToolsPath("tenant-1", range);

    for (const path of [usage, activity, tools]) {
      const url = new URL(path, "http://local");
      expect(url.searchParams.get("from")).toBe(range.from);
      expect(url.searchParams.get("to")).toBe(range.to);
    }

    expect(usage.startsWith("/api/tenants/tenant-1/insights/usage?")).toBe(
      true,
    );
    expect(
      activity.startsWith("/api/tenants/tenant-1/insights/activity?"),
    ).toBe(true);
    expect(tools.startsWith("/api/tenants/tenant-1/insights/tools?")).toBe(
      true,
    );
  });
});
