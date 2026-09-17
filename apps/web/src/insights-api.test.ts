import { describe, expect, test } from "bun:test";

import { insightsTopLevelRunsPath } from "./insights-api";

describe("insightsTopLevelRunsPath", () => {
  // the native tenant-scoped top-level listing, not the deleted
  // `/top-level-runs` route (or its `feed=fires` variant) and not the dead
  // `/me/workflows/runs`. deleted `packages/insights` and its
  // usage/activity/tools/latency/scope routes entirely.
  test("hits the native tenant-scoped GET /workflows/runs listing", () => {
    const path = insightsTopLevelRunsPath("tenant-1");
    expect(path.startsWith("/api/tenants/tenant-1/workflows/runs?")).toBe(true);
    expect(path).not.toContain("/top-level-runs");
    expect(path).not.toContain("/me/workflows/runs");
  });
});
