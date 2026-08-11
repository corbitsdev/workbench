import { describe, expect, test } from "bun:test";

import {
  createInsightsWindow,
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
