import { describe, expect, test } from "bun:test";

import type { Workbench } from "@corbits/chat-ui";

import { resolveLibraryWorkbenchScope } from "./library-workbench-scope";

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

describe("resolveLibraryWorkbenchScope", () => {
  test("resolves a workbench's own tenant and title", () => {
    const workbenches = [
      workbench({
        id: "ch_1",
        title: "Growth",
        tenancy: { tenantId: "tnt_1" },
      }),
    ];
    expect(resolveLibraryWorkbenchScope(workbenches, "ch_1")).toEqual({
      tenantId: "tnt_1",
      title: "Growth",
    });
  });

  test("returns null with no workbench id", () => {
    expect(resolveLibraryWorkbenchScope([], null)).toBeNull();
  });

  test("returns null for an id absent from the bench's workbench list", () => {
    const workbenches = [
      workbench({ id: "ch_1", tenancy: { tenantId: "tnt_1" } }),
    ];
    expect(resolveLibraryWorkbenchScope(workbenches, "ch_stale")).toBeNull();
  });

  test("returns null for a true legacy workbench with no tenancy", () => {
    const workbenches = [workbench({ id: "ch_2", tenancy: null })];
    expect(resolveLibraryWorkbenchScope(workbenches, "ch_2")).toBeNull();
  });
});
