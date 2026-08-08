import { describe, expect, test } from "bun:test";

import type { BenchMember, BenchMembership } from "../src/api";
import {
  canCreateBench,
  deriveBenchSlug,
  memberDisplayName,
  memberRoleLabel,
  membershipDisplay,
} from "../src/membership";

describe("deriveBenchSlug", () => {
  test("lowercases and kebab-cases a name", () => {
    expect(deriveBenchSlug("Launch Team")).toBe("launch-team");
  });

  test("strips punctuation", () => {
    expect(deriveBenchSlug("Launch Team!")).toBe("launch-team");
  });

  test("trims leading and trailing dashes", () => {
    expect(deriveBenchSlug("  --Acme--  ")).toBe("acme");
  });

  test("collapses runs of non-alphanumeric characters", () => {
    expect(deriveBenchSlug("A / B  &  C")).toBe("a-b-c");
  });

  test("returns an empty string for input with no derivable slug", () => {
    expect(deriveBenchSlug("   ")).toBe("");
    expect(deriveBenchSlug("!!!")).toBe("");
  });
});

describe("canCreateBench", () => {
  test("requires a name with a derivable slug", () => {
    expect(canCreateBench("")).toBe(false);
    expect(canCreateBench("   ")).toBe(false);
    expect(canCreateBench("!!!")).toBe(false);
    expect(canCreateBench("Acme")).toBe(true);
  });
});

function membership(overrides: Partial<BenchMembership>): BenchMembership {
  return {
    principalId: "prn_1",
    tenantId: "tnt_1",
    tenantName: "Acme",
    tenantSlug: "acme",
    kind: "user",
    status: "active",
    roles: [],
    ...overrides,
  };
}

describe("membershipDisplay", () => {
  test("joins multiple role names", () => {
    const display = membershipDisplay(
      membership({
        roles: [
          { id: "role_1", name: "owner" },
          { id: "role_2", name: "admin" },
        ],
      }),
    );
    expect(display.roleLabel).toBe("owner, admin");
  });

  test("falls back to 'none' with no roles", () => {
    const display = membershipDisplay(membership({ roles: [] }));
    expect(display.roleLabel).toBe("none");
  });

  test("carries the server-resolved tenant name through untouched", () => {
    const display = membershipDisplay(
      membership({ tenantName: "Ada's Bench" }),
    );
    expect(display.name).toBe("Ada's Bench");
  });
});

function member(overrides: Partial<BenchMember>): BenchMember {
  return {
    id: "prn_1",
    tenantId: "tnt_1",
    kind: "user",
    refId: "user_1",
    displayName: "Ada Lovelace",
    status: "active",
    roles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("memberDisplayName", () => {
  test("passes through a real display name", () => {
    expect(memberDisplayName(member({ displayName: "Ada Lovelace" }))).toBe(
      "Ada Lovelace",
    );
  });

  test("replaces a raw principal-ref-id fallback with friendly copy", () => {
    expect(
      memberDisplayName(member({ kind: "agent", displayName: "ins_cd03d8e3" })),
    ).toBe("Unnamed member");
  });

  test("replaces a raw tenant/role-shaped id too, defensively", () => {
    expect(memberDisplayName(member({ displayName: "tnt_abc123" }))).toBe(
      "Unnamed member",
    );
  });
});

describe("memberRoleLabel", () => {
  test("joins role names", () => {
    expect(
      memberRoleLabel(member({ roles: [{ id: "role_1", name: "member" }] })),
    ).toBe("member");
  });

  test("falls back to 'none' with no roles", () => {
    expect(memberRoleLabel(member({ roles: [] }))).toBe("none");
  });
});
