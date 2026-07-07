import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { GrantStore } from "@intx/authz";

// The guard resolves userId -> principalId via ensureMember; vary it per test.
let callerPrincipalId = "prn_member";
mock.module("../lib/tenant-provisioning", () => ({
  ensureMember: async () => ({
    tenantId: "ten_root",
    principalId: callerPrincipalId,
  }),
}));

const { createOwnerRouter } = await import("./owner");

// Real @intx/authz evaluation over a fake grant store: the owner principal holds
// the `*`/`*` allow grant (what the `owner` system role carries); the admin
// principal holds the three `*`/{read,create,manage} grants the `admin` role
// carries; a member holds none. The guard's isOwner() -> authorize() runs for
// real, so this exercises route -> owner guard -> grant-evaluation end to end
// and pins the owner-vs-admin boundary at the route layer.
function grantStoreFor(): GrantStore {
  return {
    collectGrants: async (principalId: string) => {
      const base = {
        effect: "allow" as const,
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId,
      };
      if (principalId === "prn_owner") {
        return [{ ...base, id: "grt_owner", resource: "*", action: "*" }];
      }
      if (principalId === "prn_admin") {
        return (["read", "create", "manage"] as const).map((action) => ({
          ...base,
          id: `grt_admin_${action}`,
          resource: "*",
          action,
        }));
      }
      return [];
    },
  } as unknown as GrantStore;
}

function buildApp() {
  const db = {} as never;
  const app = new Hono<{
    Variables: { userId: string; ownerPrincipalId: string };
  }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createOwnerRouter({
      db,
      grantStore: grantStoreFor(),
      rootTenantId: "ten_root",
    }),
  );
  return app;
}

describe("owner grant gate", () => {
  it("allows an owner (holds */* wildcard grant)", async () => {
    callerPrincipalId = "prn_owner";
    const res = await buildApp().request("/owner/context");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      ownerPrincipalId: string;
    };
    expect(body.tenantId).toBe("ten_root");
    expect(body.ownerPrincipalId).toBe("prn_owner");
  });

  it("denies a customer admin (admin but not owner) with 403", async () => {
    callerPrincipalId = "prn_admin";
    const res = await buildApp().request("/owner/context");
    expect(res.status).toBe(403);
  });

  it("denies a plain member with 403", async () => {
    callerPrincipalId = "prn_member";
    const res = await buildApp().request("/owner/context");
    expect(res.status).toBe(403);
  });
});
