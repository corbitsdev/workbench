import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { GrantStore } from "@intx/authz";

// CL-3451: GET /me/connections must report per-provider whether the owner has
// registered that provider's OAuth app (`configured`), so the client can
// disable Connect instead of letting the member hit the authorize 400.

let allowedProviders: Set<string>;
const revokeCalls: { provider: string; enabled: boolean }[] = [];
mock.module("../lib/capability-grants", () => ({
  isCapabilityAllowedForPrincipal: async (
    _store: unknown,
    _tenantId: string,
    _principalId: string,
    providerName: string,
  ) => allowedProviders.has(providerName),
  setPrincipalCapabilityGrant: async (
    _db: unknown,
    args: { provider: string; enabled: boolean },
  ) => {
    revokeCalls.push({ provider: args.provider, enabled: args.enabled });
  },
}));

mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => ({}),
}));

let configuredProviders: Set<string>;
const deletedProviders: string[] = [];
mock.module("../lib/oauth-flow", () => ({
  findMemberConnection: async () => null,
  resolveOwnerOAuthClient: async (
    _db: unknown,
    _tenantId: string,
    cfg: { providerName: string },
  ) => (configuredProviders.has(cfg.providerName) ? { clientId: "x" } : null),
  beginConnect: () => ({ redirectUrl: "https://example.test/authorize" }),
  deleteMemberConnection: async (
    _db: unknown,
    _tenantId: string,
    _principalId: string,
    providerName: string,
  ) => {
    deletedProviders.push(providerName);
    return 1;
  },
}));

mock.module("../lib/tenant-provisioning", () => ({
  resolveCallerMember: async () => ({
    tenantId: "ten_root",
    principalId: "prn_member",
  }),
}));

mock.module("../config", () => ({
  requireOAuthStateSecret: () => "test-state-secret",
}));

const { createMeConnectionsRouter } = await import("./me-connections");

function buildApp() {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createMeConnectionsRouter({
      db: {} as never,
      grantStore: {} as GrantStore,
      pendingStore: {} as never,
      redirectUriBase: "https://hub.test",
    }),
  );
  return app;
}

describe("GET /me/connections — configured field", () => {
  beforeEach(() => {
    allowedProviders = new Set(["linear", "attio"]);
    configuredProviders = new Set(["linear"]);
  });

  it("reports configured: true only for providers with a registered owner OAuth app", async () => {
    const res = await buildApp().request("/me/connections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: { provider: string; configured: boolean }[];
    };
    const linear = body.connections.find((c) => c.provider === "linear");
    const attio = body.connections.find((c) => c.provider === "attio");
    expect(linear?.configured).toBe(true);
    expect(attio?.configured).toBe(false);
  });
});

describe("DELETE /me/connections/:provider — disconnect (CL-3510)", () => {
  beforeEach(() => {
    allowedProviders = new Set(["linear", "attio"]);
    configuredProviders = new Set(["linear"]);
    revokeCalls.length = 0;
    deletedProviders.length = 0;
  });

  it("deletes the credential and revokes the capability grant", async () => {
    const res = await buildApp().request("/me/connections/linear", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(deletedProviders).toEqual(["linear"]);
    expect(revokeCalls).toEqual([{ provider: "linear", enabled: false }]);
  });

  it("404s an unknown provider without touching credentials or grants", async () => {
    const res = await buildApp().request("/me/connections/nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(deletedProviders).toEqual([]);
    expect(revokeCalls).toEqual([]);
  });
});
