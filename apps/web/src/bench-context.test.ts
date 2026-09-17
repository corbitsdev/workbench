import { describe, expect, test } from "bun:test";

import { resolveSelection } from "./bench-context";
import type { Principal } from "./api";

function membership(overrides: Partial<Principal> & { tenantId: string }): Principal {
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
  test("a named tenant sorting first wins — no kinds lookup to skip it", () => {
    const memberships = [
      membership({ tenantId: "tnt_first", tenantName: "Myra" }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];

    const resolved = resolveSelection(memberships, null);

    expect(resolved?.tenantId).toBe("tnt_first");
  });

  test("a raw-id tenant sorting first is skipped in favor of the first named bench", () => {
    const memberships = [
      membership({
        tenantId: "tnt_raw",
        tenantName: "ins_71f5c0c9c30026859014ccd9df8b1",
      }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];

    const resolved = resolveSelection(memberships, null);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a stored selection that still names a bench wins over the first membership", () => {
    const memberships = [
      membership({ tenantId: "tnt_bench_a", tenantName: "A" }),
      membership({ tenantId: "tnt_bench_b", tenantName: "B" }),
    ];

    const resolved = resolveSelection(memberships, "tnt_bench_b");

    expect(resolved?.tenantId).toBe("tnt_bench_b");
  });

  test("a stored selection naming a raw-id tenant falls through to the first named bench", () => {
    const memberships = [
      membership({
        tenantId: "tnt_raw",
        tenantName: "ins_71f5c0c9c30026859014ccd9df8b1",
      }),
      membership({ tenantId: "tnt_bench", tenantName: "Launch Team" }),
    ];

    const resolved = resolveSelection(memberships, "tnt_raw");

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a stored selection for a tenant no longer in memberships falls through", () => {
    const memberships = [membership({ tenantId: "tnt_bench", tenantName: "Launch Team" })];

    const resolved = resolveSelection(memberships, "tnt_gone");

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("undefined when every membership is a raw-id tenant", () => {
    const memberships = [membership({ tenantId: "tnt_raw", tenantName: "tnt_raw" })];

    const resolved = resolveSelection(memberships, null);

    expect(resolved).toBeUndefined();
  });
});
