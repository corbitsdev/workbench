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

function buildApp(db: unknown = {}) {
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
      db: db as never,
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

// The Catalog (inference) + Capabilities (tool) credential rows (CL-2879/
// CL-2883) — secrets must be WRITE-ONLY end to end: every assertion below
// checks the response body never carries a `secret`/`refreshSecret` field, on
// top of the ordinary owner-guard checks.
describe("owner credentials routes", () => {
  function credentialsDb(opts: {
    providers?: { id: string; name: string }[];
    credentials?: { id: string; providerId: string; updatedAt: Date }[];
  }) {
    const providers = opts.providers ?? [];
    const credentials = opts.credentials ?? [];
    const insertedProviders: unknown[] = [];
    const insertedCredentials: unknown[] = [];
    const updatedCredentials: unknown[] = [];
    const deletedCredentialIds: string[] = [];

    const db = {
      query: {
        provider: {
          findMany: async () => providers,
          findFirst: async () => providers[0] ?? undefined,
        },
        credential: {
          findMany: async () => credentials,
          findFirst: async () => credentials[0] ?? undefined,
        },
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          // Distinguish by shape, not by table identity: the fake has to
          // serve provider/credential inserts from the route AND the
          // fire-and-forget admin-audit insert (`recordAudit`) without
          // cross-contaminating the assertion arrays below.
          if ("plugin" in vals) {
            insertedProviders.push(vals);
            return {
              returning: async () => [
                { id: (vals["id"] as string) ?? "provider_new" },
              ],
            };
          }
          if ("secret" in vals) {
            insertedCredentials.push(vals);
            return {
              returning: async () => [
                { updatedAt: (vals["updatedAt"] as Date) ?? new Date() },
              ],
            };
          }
          // Admin-audit row (or anything else unrelated to this route) —
          // fire-and-forget, no `.returning()` call site to satisfy.
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updatedCredentials.push(vals);
              return [{ updatedAt: (vals["updatedAt"] as Date) ?? new Date() }];
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            const ids = credentials.map((c) => c.id);
            deletedCredentialIds.push(...ids);
            return ids.map((id) => ({ id }));
          },
        }),
      }),
    };
    return {
      db,
      insertedProviders,
      insertedCredentials,
      updatedCredentials,
      deletedCredentialIds,
    };
  }

  it("denies a plain member with 403", async () => {
    callerPrincipalId = "prn_member";
    const { db } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials");
    expect(res.status).toBe(403);
  });

  it("lists masked configured/missing state with kind and no secret field", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({
      providers: [{ id: "provider_1", name: "anthropic" }],
      credentials: [
        {
          id: "credential_1",
          providerId: "provider_1",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await buildApp(db).request("/owner/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: {
        providerName: string;
        kind: string;
        configured: boolean;
        updatedAt: string | null;
      }[];
    };
    const anthropic = body.credentials.find(
      (c) => c.providerName === "anthropic",
    );
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.kind).toBe("inference");
    expect(anthropic?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    const granola = body.credentials.find((c) => c.providerName === "granola");
    expect(granola?.kind).toBe("tool");
    const missing = body.credentials.find((c) => c.providerName === "exa");
    expect(missing?.configured).toBe(false);
    expect(missing?.kind).toBe("tool");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("PUT sets a credential and never echoes the secret back", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedCredentials, insertedProviders } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "sk-super-secret" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; kind: string };
    expect(body.configured).toBe(true);
    expect(body.kind).toBe("inference");
    expect(JSON.stringify(body)).not.toContain("sk-super-secret");
    expect(insertedProviders).toHaveLength(1);
    expect(insertedCredentials).toHaveLength(1);
    expect((insertedCredentials[0] as { secret: string }).secret).toBe(
      "sk-super-secret",
    );
  });

  it("PUT rejects an unknown provider with 404", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials/not-a-thing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "sk-super-secret" }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT rejects an empty secret with 400", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE clears a credential and reports not-configured", async () => {
    callerPrincipalId = "prn_owner";
    const { db, deletedCredentialIds } = credentialsDb({
      providers: [{ id: "provider_1", name: "anthropic" }],
      credentials: [
        {
          id: "credential_1",
          providerId: "provider_1",
          updatedAt: new Date(),
        },
      ],
    });
    const res = await buildApp(db).request("/owner/credentials/anthropic", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      updatedAt: string | null;
    };
    expect(body.configured).toBe(false);
    expect(body.updatedAt).toBeNull();
    expect(deletedCredentialIds).toContain("credential_1");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("PUT on a tool-kind provider (granola) never echoes the secret", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials/granola", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "grn-secret-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; kind: string };
    expect(body.kind).toBe("tool");
    expect(JSON.stringify(body)).not.toContain("grn-secret-token");
  });
});
