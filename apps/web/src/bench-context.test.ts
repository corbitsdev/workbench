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

/** `null` = a top-level tenant (a bench); a string = its parent's id (a
 * room, or any other child tenant). Missing entries model a tenant whose
 * detail hasn't loaded yet. */
function parents(entries: Record<string, string | null>): ReadonlyMap<string, string | null> {
  return new Map(Object.entries(entries));
}

describe("resolveSelection", () => {
  test("a bench sorting first wins over a room, regardless of name", () => {
    const memberships = [
      membership({ tenantId: "tnt_bench", tenantName: "Growth Team" }),
      membership({ tenantId: "tnt_room", tenantName: "Launch Planning" }),
    ];
    const parentByTenantId = parents({ tnt_bench: null, tnt_room: "tnt_bench" });

    const resolved = resolveSelection(memberships, null, parentByTenantId);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a room sorting first is skipped in favor of the first bench", () => {
    const memberships = [
      membership({ tenantId: "tnt_room", tenantName: "Launch Planning" }),
      membership({ tenantId: "tnt_bench", tenantName: "Growth Team" }),
    ];
    const parentByTenantId = parents({ tnt_room: "tnt_bench", tnt_bench: null });

    const resolved = resolveSelection(memberships, null, parentByTenantId);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a stored selection that still names a bench wins over the first membership", () => {
    const memberships = [
      membership({ tenantId: "tnt_bench_a" }),
      membership({ tenantId: "tnt_bench_b" }),
    ];
    const parentByTenantId = parents({ tnt_bench_a: null, tnt_bench_b: null });

    const resolved = resolveSelection(memberships, "tnt_bench_b", parentByTenantId);

    expect(resolved?.tenantId).toBe("tnt_bench_b");
  });

  test("a stored selection naming a room falls through to the first bench — a room can never be selected even when it is the stored id", () => {
    const memberships = [
      membership({ tenantId: "tnt_room" }),
      membership({ tenantId: "tnt_bench" }),
    ];
    const parentByTenantId = parents({ tnt_room: "tnt_bench", tnt_bench: null });

    const resolved = resolveSelection(memberships, "tnt_room", parentByTenantId);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("a stored selection for a tenant no longer in memberships falls through", () => {
    const memberships = [membership({ tenantId: "tnt_bench" })];
    const parentByTenantId = parents({ tnt_bench: null });

    const resolved = resolveSelection(memberships, "tnt_gone", parentByTenantId);

    expect(resolved?.tenantId).toBe("tnt_bench");
  });

  test("undefined when every membership is a room", () => {
    const memberships = [membership({ tenantId: "tnt_room" })];
    const parentByTenantId = parents({ tnt_room: "tnt_primary" });

    const resolved = resolveSelection(memberships, null, parentByTenantId);

    expect(resolved).toBeUndefined();
  });

  test("undefined while a tenant's parent hasn't loaded yet — never guessed as a bench", () => {
    const memberships = [membership({ tenantId: "tnt_unknown" })];
    const parentByTenantId = parents({});

    const resolved = resolveSelection(memberships, null, parentByTenantId);

    expect(resolved).toBeUndefined();
  });
});
