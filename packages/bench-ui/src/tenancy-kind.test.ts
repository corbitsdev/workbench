import { describe, expect, test } from "bun:test";

import {
  classifyBenchMembership,
  filterWorkbenchMemberships,
} from "./tenancy-kind";
import type { BenchMembership } from "./api";

function membership(
  overrides: Partial<BenchMembership> & {
    tenantId: string;
    tenantName: string;
  },
): BenchMembership {
  return {
    principalId: `prn_${overrides.tenantId}`,
    tenantSlug: overrides.tenantName.toLowerCase(),
    kind: "user",
    status: "active",
    roles: [],
    ...overrides,
  };
}

describe("classifyBenchMembership", () => {
  test("a named tenant absent from channelTenantIds is a workbench", () => {
    const result = classifyBenchMembership(
      membership({ tenantId: "tnt_a", tenantName: "Launch Team" }),
      new Set(),
    );
    expect(result).toBe("workbench");
  });

  test("a named tenant present in channelTenantIds is a channel", () => {
    const result = classifyBenchMembership(
      membership({ tenantId: "tnt_a", tenantName: "Myra" }),
      new Set(["tnt_a"]),
    );
    expect(result).toBe("channel");
  });

  test("a tenant whose name is a raw platform id is unknown, never a workbench", () => {
    const result = classifyBenchMembership(
      membership({
        tenantId: "tnt_b",
        tenantName: "ins_71f5c0c9c30026859014ccd9df8b1",
      }),
      new Set(),
    );
    expect(result).toBe("unknown");
  });

  test("a raw-named tenant is unknown even when it is also a channel tenancy", () => {
    const result = classifyBenchMembership(
      membership({ tenantId: "tnt_c", tenantName: "tnt_c" }),
      new Set(["tnt_c"]),
    );
    expect(result).toBe("unknown");
  });
});

describe("filterWorkbenchMemberships", () => {
  test("keeps only workbench-kind memberships, in order", () => {
    const memberships = [
      membership({ tenantId: "tnt_a", tenantName: "Launch Team" }),
      membership({ tenantId: "tnt_b", tenantName: "Myra" }),
      membership({ tenantId: "tnt_c", tenantName: "Test" }),
      membership({
        tenantId: "tnt_d",
        tenantName: "ins_71f5c0c9c30026859014ccd9df8b1",
      }),
      membership({ tenantId: "tnt_e", tenantName: "Growth" }),
    ];
    const channelTenantIds = new Set(["tnt_b", "tnt_c"]);

    const result = filterWorkbenchMemberships(memberships, channelTenantIds);

    expect(result.map((m) => m.tenantId)).toEqual(["tnt_a", "tnt_e"]);
  });

  test("an empty membership list stays empty", () => {
    expect(filterWorkbenchMemberships([], new Set())).toEqual([]);
  });
});
