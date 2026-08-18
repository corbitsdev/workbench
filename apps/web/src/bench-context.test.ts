import { describe, expect, test } from "bun:test";

import { resolveSelection } from "./bench-context";
import type { Principal } from "./api";

function membership(
  overrides: Partial<Principal> & { tenantId: string },
): Principal {
  return {
    principalId: `prn_${overrides.tenantId}`,
    tenantName: overrides.tenantId,
    tenantSlug: overrides.tenantId,
    kind: "user",
    status: "active",
    roles: [],
    ...overrides,
  };
}

describe("resolveSelection", () => {
  test("a workbench tenant sorting first is skipped in favor of the first workbench", () => {
    const memberships = [
      membership({ tenantId: "tnt_workbench", tenantName: "Myra" }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];
    const workbenchTenantIds = new Set(["tnt_workbench"]);

    const resolved = resolveSelection(memberships, null, workbenchTenantIds);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a raw-id tenant sorting first is skipped even before workbenchTenantIds resolves", () => {
    const memberships = [
      membership({
        tenantId: "tnt_raw",
        tenantName: "ins_71f5c0c9c30026859014ccd9df8b1",
      }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];

    const resolved = resolveSelection(memberships, null, new Set());

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a stored selection that still names a workbench wins over the first membership", () => {
    const memberships = [
      membership({ tenantId: "tnt_bench_a", tenantName: "A" }),
      membership({ tenantId: "tnt_bench_b", tenantName: "B" }),
    ];

    const resolved = resolveSelection(memberships, "tnt_bench_b", new Set());

    expect(resolved?.tenantId).toBe("tnt_bench_b");
  });

  test("a stored selection that turns out to be a workbench self-corrects to a workbench", () => {
    const memberships = [
      membership({ tenantId: "tnt_workbench", tenantName: "Myra" }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];

    // Before the kinds lookup resolves, the stored workbench id still
    // matches — nothing to distinguish it yet.
    const beforeKinds = resolveSelection(
      memberships,
      "tnt_workbench",
      new Set(),
    );
    expect(beforeKinds?.tenantId).toBe("tnt_workbench");

    // Once workbenchTenantIds arrives, the same stored id is re-evaluated
    // and no longer honored.
    const afterKinds = resolveSelection(
      memberships,
      "tnt_workbench",
      new Set(["tnt_workbench"]),
    );
    expect(afterKinds?.tenantId).toBe("tnt_bench");
  });

  test("undefined when every membership is a workbench or raw-id tenant", () => {
    const memberships = [
      membership({ tenantId: "tnt_workbench", tenantName: "Myra" }),
    ];

    const resolved = resolveSelection(
      memberships,
      null,
      new Set(["tnt_workbench"]),
    );

    expect(resolved).toBeUndefined();
  });
});
