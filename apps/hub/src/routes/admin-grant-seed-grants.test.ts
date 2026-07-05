import { describe, expect, it } from "bun:test";
import { authorize, type GrantStore } from "@intx/authz";
import { ADMIN_ACTION, ADMIN_RESOURCE } from "@workbench/shared";

// Regression guard for the read-vs-manage boundary of the admin gate, evaluated
// through the REAL @intx/authz engine (no DB). Confirms which seeded system-role
// grants satisfy `admin:*`/`manage` and — critically — that lesser capability
// grants (member read, insights read, grant-manage) do NOT. If a future change
// loosened the gate to accept a broader match, these fail. (Relocated from the
// critique review's scratch suite.)

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

describe("admin gate vs real seeded grants", () => {
  it("member (*/read) is DENIED admin:* / manage", async () => {
    const store = storeWith([{ ...base, resource: "*", action: "read" }]);
    const r = await authorize(store, "p", "t", ADMIN_RESOURCE, ADMIN_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("admin (*/manage) is ALLOWED", async () => {
    const store = storeWith([{ ...base, resource: "*", action: "manage" }]);
    const r = await authorize(store, "p", "t", ADMIN_RESOURCE, ADMIN_ACTION);
    expect(r.effect).toBe("allow");
  });

  it("owner (*/*) is ALLOWED", async () => {
    const store = storeWith([{ ...base, resource: "*", action: "*" }]);
    const r = await authorize(store, "p", "t", ADMIN_RESOURCE, ADMIN_ACTION);
    expect(r.effect).toBe("allow");
  });

  it("insights-read (activity:principal/read) does NOT satisfy the admin gate", async () => {
    const store = storeWith([
      { ...base, resource: "activity:principal", action: "read" },
    ]);
    const r = await authorize(store, "p", "t", ADMIN_RESOURCE, ADMIN_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("grant-manage (grant:*/manage) does NOT satisfy the admin gate", async () => {
    const store = storeWith([
      { ...base, resource: "grant:*", action: "manage" },
    ]);
    const r = await authorize(store, "p", "t", ADMIN_RESOURCE, ADMIN_ACTION);
    expect(r.effect).not.toBe("allow");
  });

  it("no grants => DENIED", async () => {
    const r = await authorize(
      storeWith([]),
      "p",
      "t",
      ADMIN_RESOURCE,
      ADMIN_ACTION,
    );
    expect(r.effect).not.toBe("allow");
  });
});
