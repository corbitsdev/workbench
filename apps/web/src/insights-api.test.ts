import { describe, expect, test } from "bun:test";

import { insightsTopLevelRunsPath } from "./insights-api";

describe("insightsTopLevelRunsPath", () => {
  // Not the deleted `/top-level-runs` or `/me/workflows/runs` routes.
  test("hits the native tenant-scoped GET /workflows/runs listing", () => {
    const path = insightsTopLevelRunsPath("tenant-1");
    expect(path.startsWith("/api/tenants/tenant-1/workflows/runs?")).toBe(true);
    expect(path).not.toContain("/top-level-runs");
    expect(path).not.toContain("/me/workflows/runs");
  });
});
