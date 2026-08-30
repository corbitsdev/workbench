// Route-level proof that POST /api/tenants cannot be used to bypass
// @workbench/access-policy — see ./src/tenant-create-guard.ts's module
// comment for the [Intx gap] this guards against (CL-6041). No real DB
// or full hub boot required: `guardedHubApp` wraps a minimal stub
// "native" app standing in for the vendored tenant route, and role
// resolution is injected as a plain function (the same seam
// `apps/hub/src/index.ts` wires to a real `resolveCallerRoleNames(db, ...)`
// in production), so these tests exercise exactly the guard's own
// decision without touching Postgres.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import { createInMemoryAccessPolicyStore } from "@workbench/access-policy";

import {
  guardedHubApp,
  type TenantCreateGuardDeps,
} from "../src/tenant-create-guard";

type FakeUser = { id: string; email: string; emailVerified: boolean };

function stubNativeApp(): { app: Hono<AppEnv>; created: unknown[] } {
  const app = new Hono<AppEnv>();
  const created: unknown[] = [];
  app.post("/api/tenants", async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    created.push(body);
    return c.json({ id: "tnt_new", name: "New", slug: "new" }, 201);
  });
  return { app, created };
}

/** No membership anywhere — the fake `resolveCallerRoleNames` every
 * "not a member" test uses. */
async function noMembership(): Promise<undefined> {
  return undefined;
}

function depsFor(args: {
  user: FakeUser | undefined;
  operatorTenantId?: string;
  envSignupMode?: "open" | "closed";
  resolveCallerRoleNames?: TenantCreateGuardDeps["resolveCallerRoleNames"];
  policiesByTenant?: Record<
    string,
    { tenancyCreation: "owners" | "owners-admins" | "none" }
  >;
}): TenantCreateGuardDeps {
  const store = createInMemoryAccessPolicyStore();
  for (const [tenantId, policy] of Object.entries(
    args.policiesByTenant ?? {},
  )) {
    void store.upsertPolicy(tenantId, policy);
  }

  const deps: TenantCreateGuardDeps = {
    store,
    resolveCallerRoleNames: args.resolveCallerRoleNames ?? noMembership,
    envSignupMode: args.envSignupMode ?? "closed",
    envAllowedDomains: [],
    allowUnverifiedEmails: false,
    getSessionUser: async () => args.user,
  };
  if (args.operatorTenantId !== undefined) {
    deps.operatorTenantId = args.operatorTenantId;
  }
  return deps;
}

describe("guardedHubApp — bypass shape A: unauthenticated caller", () => {
  test("POST /api/tenants without a session is rejected before the native route ever runs", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const wrapped = guardedHubApp(nativeApp, depsFor({ user: undefined }));

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Evil", slug: "evil" }),
    });

    expect(response.status).toBe(401);
    expect(created).toHaveLength(0);
  });
});

describe("guardedHubApp — bypass shape B: arbitrary parentId under a tenant the caller does not belong to", () => {
  test("an authenticated user cannot become owner of a child under a tenant they aren't a member of", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: {
        id: "usr_1",
        email: "attacker@evil.example",
        emailVerified: true,
      },
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hostile Takeover",
        slug: "hostile",
        parentId: "tnt_victim",
      }),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("not_a_member");
    expect(created).toHaveLength(0);
  });

  test("a genuine owner-member of the parent may create a sub-workbench under it", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: { id: "usr_2", email: "owner@acme.example", emailVerified: true },
      resolveCallerRoleNames: async (tenantId, userId) =>
        tenantId === "tnt_acme" && userId === "usr_2" ? ["owner"] : undefined,
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sub bench",
        slug: "sub-bench",
        parentId: "tnt_acme",
      }),
    });
    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("a member without a sufficient role is denied by the parent's own tenancyCreation policy", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: {
        id: "usr_3",
        email: "member@acme.example",
        emailVerified: true,
      },
      resolveCallerRoleNames: async (tenantId, userId) =>
        tenantId === "tnt_acme" && userId === "usr_3" ? ["member"] : undefined,
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sub bench",
        slug: "sub-bench",
        parentId: "tnt_acme",
      }),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("tenancy_creation_forbidden");
    expect(created).toHaveLength(0);
  });

  test("an admin is denied by the default owners tenancyCreation policy", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: {
        id: "usr_admin",
        email: "admin@acme.example",
        emailVerified: true,
      },
      resolveCallerRoleNames: async (tenantId, userId) =>
        tenantId === "tnt_acme" && userId === "usr_admin"
          ? ["admin"]
          : undefined,
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sub bench",
        slug: "sub-bench",
        parentId: "tnt_acme",
      }),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("tenancy_creation_forbidden");
    expect(created).toHaveLength(0);
  });

  test("owners-admins policy also accepts an admin", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: { id: "usr_8", email: "admin@acme.example", emailVerified: true },
      resolveCallerRoleNames: async () => ["admin"],
      policiesByTenant: { tnt_acme: { tenancyCreation: "owners-admins" } },
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sub bench",
        slug: "sub-bench",
        parentId: "tnt_acme",
      }),
    });
    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
  });
});

describe("guardedHubApp — top-level and operator-tenant creation go through the signup gate", () => {
  test("no parentId, signup closed -> denied, fail closed", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: { id: "usr_4", email: "new@acme.example", emailVerified: true },
      envSignupMode: "closed",
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mine", slug: "mine" }),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("signup_not_allowed");
    expect(created).toHaveLength(0);
  });

  test("no parentId, signup open and email verified -> allowed", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: { id: "usr_5", email: "new@acme.example", emailVerified: true },
      envSignupMode: "open",
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mine", slug: "mine" }),
    });
    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("exploit: an unverified email cannot self-provision even with signup open", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: {
        id: "usr_6",
        email: "unverified@acme.example",
        emailVerified: false,
      },
      envSignupMode: "open",
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mine", slug: "mine" }),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("signup_not_allowed");
    expect(created).toHaveLength(0);
  });

  test("parentId equal to the operator tenant follows the same signup gate as no parentId", async () => {
    const { app: nativeApp, created } = stubNativeApp();
    const deps = depsFor({
      user: { id: "usr_7", email: "new@acme.example", emailVerified: true },
      operatorTenantId: "tnt_operator",
      envSignupMode: "open",
    });
    const wrapped = guardedHubApp(nativeApp, deps);

    const response = await wrapped.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Mine",
        slug: "mine",
        parentId: "tnt_operator",
      }),
    });
    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("GET requests to /api/tenants/:id are never intercepted", async () => {
    const app = new Hono<AppEnv>();
    app.get("/api/tenants/tnt_1", (c) => c.json({ id: "tnt_1" }));
    const wrapped = guardedHubApp(app, depsFor({ user: undefined }));

    const response = await wrapped.request("/api/tenants/tnt_1");
    expect(response.status).toBe(200);
  });
});
