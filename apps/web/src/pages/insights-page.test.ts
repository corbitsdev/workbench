// CL-6099: the landing view's default scope must always be something the
// caller can actually see — resolveInsightsScope is the pure decision
// InsightsRoute defers to, covered here directly against both membership
// shapes `/scope` (packages/insights/src/routes.ts) can now report: a
// workspace member (parent present) and a non-member (parent absent).
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
      workbenchId: null,
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(result.effectiveTenantId).toBe("tnt_workspace");
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("non-member default landing: caller's own current workbench, labeled with its name", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      workbenchId: null,
      selectedTenantId: "tnt_bench_a",
      scopeData: nonMemberScope,
    });
    expect(result.effectiveTenantId).toBe("tnt_bench_a");
    expect(result.scopeLabel).toBe("Support bench");
  });

  test("scope not yet resolved: falls back to the current workbench id, never blocks", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      workbenchId: null,
      selectedTenantId: "tnt_bench_a",
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBe("tnt_bench_a");
    expect(result.scopeLabel).toBe("tnt_bench_a");
  });

  test("explicit workbench deep link overrides the default outright, for either membership shape", () => {
    const memberResult = resolveInsightsScope({
      mode: "landing",
      workbenchId: "tnt_bench_b",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(memberResult.effectiveTenantId).toBe("tnt_bench_b");
    expect(memberResult.scopeLabel).toBe("Sales bench");

    const nonMemberResult = resolveInsightsScope({
      mode: "landing",
      workbenchId: "tnt_bench_a",
      selectedTenantId: "tnt_bench_a",
      scopeData: nonMemberScope,
    });
    expect(nonMemberResult.effectiveTenantId).toBe("tnt_bench_a");
    expect(nonMemberResult.scopeLabel).toBe("Support bench");
  });

  test("non-landing modes always stay tied to the current workbench, ignoring scope", () => {
    const runsResult = resolveInsightsScope({
      mode: "runs",
      workbenchId: null,
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runsResult.effectiveTenantId).toBe("tnt_bench_a");

    const runResult = resolveInsightsScope({
      mode: "run",
      workbenchId: null,
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runResult.effectiveTenantId).toBe("tnt_bench_a");
  });

  test("no selected tenant and unresolved scope: never fabricates a tenant to view", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      workbenchId: null,
      selectedTenantId: null,
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBeNull();
  });
});
