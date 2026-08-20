import { describe, expect, test } from "bun:test";

import {
  createInsightsWindow,
  INSIGHTS_WINDOW_DAYS,
} from "@corbits/insights/client";

import {
  insightsActivityPath,
  insightsToolsPath,
  insightsTopLevelRunsPath,
  insightsUsagePath,
} from "./insights-api";

// Fixed clock so range math is deterministic regardless of suite time.
const NOW = new Date("2026-01-15T18:00:00.000Z");

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

describe("insightsTopLevelRunsPath", () => {
  test("hits the tenant-scoped top-level-runs route, not /me/workflows/runs", () => {
    const path = insightsTopLevelRunsPath("tenant-1");
    expect(path.startsWith("/api/tenants/tenant-1/top-level-runs?")).toBe(true);
    expect(path).not.toContain("/me/workflows/runs");
  });
});
