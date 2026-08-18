import { describe, expect, test } from "bun:test";

import {
  canShareWorkbenchWithinParent,
  createDmWorkbenchSpec,
  dmWorkbenchName,
  emailAllowedForSignup,
  isInterchangeRole,
  parseAllowedEmailDomains,
  parseSignupMode,
  validateParentId,
  wouldCreateParentCycle,
  type TenantParentLookup,
} from "./tenancy-contracts";

function memoryLookup(
  parents: Record<string, string | null>,
): TenantParentLookup {
  return {
    async getParentId(id) {
      if (!Object.prototype.hasOwnProperty.call(parents, id)) return null;
      return parents[id] ?? null;
    },
    async exists(id) {
      return Object.prototype.hasOwnProperty.call(parents, id);
    },
  };
}

describe("parseSignupMode", () => {
  test("defaults to closed", () => {
    expect(parseSignupMode(undefined)).toBe("closed");
    expect(parseSignupMode("")).toBe("closed");
  });

  test("accepts open and closed", () => {
    expect(parseSignupMode("open")).toBe("open");
    expect(parseSignupMode("CLOSED")).toBe("closed");
  });

  test("rejects garbage", () => {
    expect(() => parseSignupMode("maybe")).toThrow(/WORKBENCH_SIGNUP/);
  });
});

describe("emailAllowedForSignup", () => {
  test("closed rejects everyone", () => {
    expect(
      emailAllowedForSignup({
        email: "alice@acme.example",
        mode: "closed",
        allowedDomains: [],
      }),
    ).toBe(false);
  });

  test("open with empty allowlist accepts any email", () => {
    expect(
      emailAllowedForSignup({
        email: "alice@acme.example",
        mode: "open",
        allowedDomains: [],
      }),
    ).toBe(true);
  });

  test("open with allowlist filters domains", () => {
    expect(
      emailAllowedForSignup({
        email: "alice@acme.example",
        mode: "open",
        allowedDomains: ["acme.example"],
      }),
    ).toBe(true);
    expect(
      emailAllowedForSignup({
        email: "bob@other.example",
        mode: "open",
        allowedDomains: ["acme.example"],
      }),
    ).toBe(false);
  });
});

describe("parseAllowedEmailDomains", () => {
  test("splits and trims", () => {
    expect(parseAllowedEmailDomains("acme.example, other.example")).toEqual([
      "acme.example",
      "other.example",
    ]);
  });

  test("empty is empty list", () => {
    expect(parseAllowedEmailDomains(undefined)).toEqual([]);
    expect(parseAllowedEmailDomains("  ")).toEqual([]);
  });
});

describe("validateParentId", () => {
  test("null parent is ok (root)", async () => {
    const lookup = memoryLookup({});
    expect(await validateParentId(null, lookup)).toEqual({ ok: true });
  });

  test("unknown parent fails", async () => {
    const lookup = memoryLookup({});
    const result = await validateParentId("missing", lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_parent");
  });

  test("existing parent is ok", async () => {
    const lookup = memoryLookup({ parent: null });
    expect(await validateParentId("parent", lookup)).toEqual({ ok: true });
  });
});

describe("wouldCreateParentCycle", () => {
  test("self-parent is a cycle", async () => {
    const lookup = memoryLookup({ a: null });
    expect(await wouldCreateParentCycle("a", "a", lookup)).toBe(true);
  });

  test("parenting under a descendant is a cycle", async () => {
    // a → b → c; reparent a under c
    const lookup = memoryLookup({ a: null, b: "a", c: "b" });
    expect(await wouldCreateParentCycle("a", "c", lookup)).toBe(true);
  });

  test("parenting under an unrelated root is fine", async () => {
    const lookup = memoryLookup({ a: null, other: null });
    expect(await wouldCreateParentCycle("a", "other", lookup)).toBe(false);
  });
});

describe("DM contract", () => {
  test("names from counterparty", () => {
    expect(dmWorkbenchName("  Ada  ")).toBe("Ada");
    expect(dmWorkbenchName("   ")).toBe("Direct message");
  });

  test("createDmWorkbenchSpec requires distinct members", () => {
    expect(() =>
      createDmWorkbenchSpec({
        counterpartyDisplayName: "Ada",
        memberUserIds: ["u1", "u1"],
      }),
    ).toThrow(/distinct/);

    const spec = createDmWorkbenchSpec({
      counterpartyDisplayName: "Ada",
      memberUserIds: ["u1", "u2"],
    });
    expect(spec.dm).toBe(true);
    expect(spec.name).toBe("Ada");
    expect(spec.memberUserIds).toEqual(["u1", "u2"]);
  });
});

describe("isInterchangeRole", () => {
  test("only owner/admin/member", () => {
    expect(isInterchangeRole("owner")).toBe(true);
    expect(isInterchangeRole("viewer")).toBe(false);
  });
});

describe("canShareWorkbenchWithinParent", () => {
  test("siblings under same parent can share", async () => {
    const lookup = memoryLookup({
      root: null,
      a: "root",
      b: "root",
    });
    expect(await canShareWorkbenchWithinParent("a", "b", lookup)).toBe(true);
  });

  test("unrelated roots cannot", async () => {
    const lookup = memoryLookup({ a: null, b: null });
    expect(await canShareWorkbenchWithinParent("a", "b", lookup)).toBe(false);
  });

  test("child and parent can share", async () => {
    const lookup = memoryLookup({ root: null, child: "root" });
    expect(await canShareWorkbenchWithinParent("child", "root", lookup)).toBe(
      true,
    );
  });
});
