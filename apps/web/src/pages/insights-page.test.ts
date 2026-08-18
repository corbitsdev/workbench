// CL-6099: the landing view's default scope must always be something the
// caller can actually see — resolveInsightsScope is the pure decision
// InsightsRoute defers to, covered here directly against both membership
// shapes `/scope` (packages/insights/src/routes.ts) can now report: a
// workspace member (parent present) and a non-member (parent absent).
// CL-5879 retired the `/insights/workbench/:tenantId` deep link that used
// to override this default outright — per-workbench Insights is now its
// own `/insights/channel/:channelId` route (see `InsightsChannelPage`),
// so this landing scope never takes a workbench override anymore.
import { describe, expect, test } from "bun:test";

import { resolveInsightsScope } from "./insights-page";
import type { InsightsScope } from "../insights-api";

const workspaceMemberScope: InsightsScope = {
  tenantId: "tnt_bench_a",
  name: "Support bench",
  parent: { tenantId: "tnt_workspace", name: "Acme workspace" },
  workbenches: [
    { tenantId: "tnt_bench_a", name: "Support bench" },
    { tenantId: "tnt_bench_b", name: "Sales bench" },
  ],
};

const nonMemberScope: InsightsScope = {
  tenantId: "tnt_bench_a",
  name: "Support bench",
  parent: null,
  workbenches: [{ tenantId: "tnt_bench_a", name: "Support bench" }],
};

describe("resolveInsightsScope", () => {
  test("workspace member default landing: parent aggregate, labeled 'All workbenches'", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(result.effectiveTenantId).toBe("tnt_workspace");
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("parentless landing IS the aggregate: every workbench's runs land on the root tenancy", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: nonMemberScope,
    });
    expect(result.effectiveTenantId).toBe(nonMemberScope.tenantId);
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("scope not yet resolved: falls back to the current workbench id, never blocks", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBe("tnt_bench_a");
    expect(result.scopeLabel).toBe("tnt_bench_a");
  });

  test("non-landing modes always stay tied to the current workbench, ignoring scope", () => {
    const runsResult = resolveInsightsScope({
      mode: "runs",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runsResult.effectiveTenantId).toBe("tnt_bench_a");

    const runResult = resolveInsightsScope({
      mode: "run",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runResult.effectiveTenantId).toBe("tnt_bench_a");
  });

  test("no selected tenant and unresolved scope: never fabricates a tenant to view", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: null,
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBeNull();
  });
});
