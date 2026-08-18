import { describe, expect, test } from "bun:test";

import type { Workbench } from "@corbits/chat-ui";

import {
  workbenchIdForWorkbenchTenant,
  resolveWorkbenchInsightsScope,
} from "./insights-workbench-scope";

function workbench(overrides: Partial<Workbench> & { id: string }): Workbench {
  return {
    title: "Growth",
    kind: "workbench",
    pinned: false,
    participants: [],
    tenancy: null,
    ...overrides,
  } as Workbench;
}

describe("resolveWorkbenchInsightsScope", () => {
  test("resolves a workbench's own workbench tenant", () => {
    const workbenches = [
      workbench({
        id: "ch_1",
        title: "Growth",
        tenancy: { tenantId: "tnt_1" },
      }),
    ];
    expect(resolveWorkbenchInsightsScope(workbenches, "ch_1")).toEqual({
      kind: "ready",
      tenantId: "tnt_1",
      title: "Growth",
    });
  });

  test("reports a true legacy workbench (tenancy null) distinctly", () => {
    const workbenches = [workbench({ id: "ch_2", tenancy: null })];
    expect(resolveWorkbenchInsightsScope(workbenches, "ch_2")).toEqual({
      kind: "legacy",
    });
  });

  test("reports not-found for an id absent from the bench's workbench list", () => {
    const workbenches = [
      workbench({ id: "ch_1", tenancy: { tenantId: "tnt_1" } }),
    ];
    expect(resolveWorkbenchInsightsScope(workbenches, "tnt_stale")).toEqual({
      kind: "not-found",
    });
  });
});

describe("workbenchIdForWorkbenchTenant", () => {
  test("finds the workbench that carries a given workbench tenant", () => {
    const workbenches = [
      workbench({ id: "ch_1", tenancy: { tenantId: "tnt_1" } }),
      workbench({ id: "ch_2", tenancy: { tenantId: "tnt_2" } }),
    ];
    expect(workbenchIdForWorkbenchTenant(workbenches, "tnt_2")).toBe("ch_2");
  });

  test("returns null when no workbench carries that tenancy", () => {
    const workbenches = [workbench({ id: "ch_1", tenancy: null })];
    expect(workbenchIdForWorkbenchTenant(workbenches, "tnt_9")).toBeNull();
  });
});
