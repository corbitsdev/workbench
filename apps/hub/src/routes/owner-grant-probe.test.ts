import { describe, expect, it } from "bun:test";
import { authorize, type GrantStore } from "@intx/authz";
import {
  ADMIN_GRANT_ACTIONS,
  OWNER_ACTION,
  OWNER_RESOURCE,
} from "@workbench/shared";

// Regression guard for the owner-vs-admin boundary, evaluated through the REAL
// @intx/authz engine (no DB). The owner gate must admit ONLY a `*`/`*` grant
// (the `owner` role) and reject the seeded `admin` grants — a customer admin is
// not an owner. The admin cases are driven from `ADMIN_GRANT_ACTIONS`, the SAME
// constant `seedSystemRolesAndGrants` uses to seed the admin role, so the seed
// and this test cannot diverge: if a future change added an `own`-matching
// action (a wildcard, or an `o*`-shaped glob) to that set, the "admin is denied"
// cases below flip to allow and fail. The grants here are synthetic in id/shape
// but their ACTIONS are the production seed's actions by construction.

interface GrantRuleLike {
  id: string;
  resource: string;
  action: string;
  effect: "allow" | "deny" | "ask";
  origin: string;
  conditions: null;
  expiresAt: null;
  roleId: string | null;
  principalId: string | null;
}

function storeWith(grants: GrantRuleLike[]): GrantStore {
  return { collectGrants: async () => grants } as unknown as GrantStore;
}

const base = {
  id: "g",
  effect: "allow" as const,
  origin: "system",
  conditions: null,
  expiresAt: null,
  roleId: null,
  principalId: "p",
};

describe("owner gate vs real seeded grants", () => {
  it("owner (*/*) is ALLOWED", async () => {
    const store = storeWith([{ ...base, resource: "*", action: "*" }]);
    const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
    expect(r.effect).toBe("allow");
  });

  it.each(ADMIN_GRANT_ACTIONS.map((a) => [a]))(
    "a seeded admin action (*/%s) is DENIED the owner gate",
    async (action) => {
      const store = storeWith([{ ...base, resource: "*", action }]);
      const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
      expect(r.effect).not.toBe("allow");
    },
  );

  it("a full admin (every seeded admin action at once) is still DENIED", async () => {
    const store = storeWith(
      ADMIN_GRANT_ACTIONS.map((action) => ({
        ...base,
        resource: "*",
        action,
      })),
    );
    const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("no seeded admin action, treated as a grant pattern, satisfies the owner probe", async () => {
    // Directly pins the invariant OWNER_ACTION documents: the owner gate is safe
    // only while no admin-seeded action pattern globs to OWNER_ACTION.
    for (const action of ADMIN_GRANT_ACTIONS) {
      const store = storeWith([{ ...base, resource: "*", action }]);
      const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
      expect(r.effect).not.toBe("allow");
    }
  });

  it("member (no role grants) is DENIED", async () => {
    const store = storeWith([]);
    const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("an explicit deny on the owner wildcard is DENIED (fail-closed)", async () => {
    const store = storeWith([
      { ...base, resource: "*", action: "*", effect: "deny" },
    ]);
    const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("an `ask` effect on the owner wildcard is NOT owner (only allow counts)", async () => {
    const store = storeWith([
      { ...base, resource: "*", action: "*", effect: "ask" },
    ]);
    const r = await authorize(store, "p", "t", OWNER_RESOURCE, OWNER_ACTION);
    expect(r.effect).not.toBe("allow");
  });
});
