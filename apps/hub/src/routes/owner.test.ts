import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { GrantStore } from "@intx/authz";
import { isEncryptedEnvelope, decryptSecret } from "../lib/credential-crypto";

// CL-3446: PUT /owner/credentials/:providerName encrypts kind:"tool" secrets
// at rest, which requires a real CREDENTIAL_ENCRYPTION_KEY in the test env.
const CREDENTIAL_ENCRYPTION_TEST_KEY = randomBytes(32).toString("base64");
beforeAll(() => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = CREDENTIAL_ENCRYPTION_TEST_KEY;
});
afterAll(() => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
});

// The guard resolves userId -> principalId via ensureMember; vary it per test.
let callerPrincipalId = "prn_member";
mock.module("../lib/tenant-provisioning", () => ({
  ensureMember: async () => ({
    tenantId: "ten_root",
    principalId: callerPrincipalId,
  }),
}));

// ─── CL-3634: owner role delegation mocks ──────────────────────────
const assignRole = mock(
  async (
    _db: unknown,
    _tenantId: string,
    _principalId: string,
    _roleId: string,
  ) => {},
);
let ownerDemoteResult: "ok" | "last-owner" = "ok";
class LastOwnerError extends Error {
  constructor() {
    super("Cannot demote the last remaining owner");
    this.name = "LastOwnerError";
  }
}
const demoteFromOwner = mock(async () => {
  if (ownerDemoteResult === "last-owner") throw new LastOwnerError();
});
let ownerRoleId: string | null = "rol_owner";
const findOwnerRoleId = mock(async () => ownerRoleId);
let membersPrincipalExists = true;
const principalExistsInTenant = mock(async () => membersPrincipalExists);
let tenantMembers: {
  id: string;
  refId: string;
  displayName: string;
  isOwner: boolean;
}[] = [];
const listTenantMembers = mock(async () => tenantMembers);
mock.module("../services/admin-governance", () => ({
  assignRole,
  demoteFromOwner,
  findOwnerRoleId,
  LastOwnerError,
  listTenantMembers,
  principalExistsInTenant,
  resolvePrincipalNames: mock(async () => new Map<string, string>()),
}));

const { createOwnerRouter } = await import("./owner");

// A minimal db that only backs `recordAudit`'s fire-and-forget
// `db.insert(adminAudit).values(...)` — every other owner-members operation
// goes through the mocked admin-governance functions above, not the db.
function membersDb() {
  const auditWrites: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        auditWrites.push(vals);
        return Promise.resolve();
      },
    }),
  };
  return { db, auditWrites };
}

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
      showDemos: ownerRouterShowDemos,
      featureEnvOverrides: ownerRouterFeatureEnvOverrides,
    }),
  );
  return app;
}

// Toggled per-test to exercise the SHOW_DEMOS env override surfaced as
// `forcedByEnv`. Reset to false by default.
let ownerRouterShowDemos = false;

// Toggled per-test to exercise a feature's emergency env override surfaced as
// `forcedByEnv`. Reset to all-false by default.
let ownerRouterFeatureEnvOverrides: Record<
  "scheduler" | "triage" | "tasks-reconciler",
  boolean
> = { scheduler: false, triage: false, "tasks-reconciler": false };

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
    providers?: { id: string; name: string; metadata?: unknown }[];
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

  it("surfaces a well-formed baseURL from provider metadata", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({
      providers: [
        {
          id: "provider_1",
          name: "anthropic",
          metadata: { baseURL: "https://bifrost.example.com" },
        },
      ],
    });
    const res = await buildApp(db).request("/owner/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: { providerName: string; baseURL?: string }[];
    };
    const anthropic = body.credentials.find(
      (c) => c.providerName === "anthropic",
    );
    expect(anthropic?.baseURL).toBe("https://bifrost.example.com");
  });

  // A hand-rolled `(metadata as Record<string, unknown>).baseURL as string`
  // would pass a wrongly-typed value straight through to the response.
  // Parsing through `ProviderMetadataSchema` rejects it instead — the field
  // is omitted, not corrupted.
  it("rejects malformed provider metadata rather than casting it through", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = credentialsDb({
      providers: [
        {
          id: "provider_1",
          name: "anthropic",
          // baseURL is a number, not a string — ProviderMetadataSchema
          // must reject this shape.
          metadata: { baseURL: 12345 },
        },
      ],
    });
    const res = await buildApp(db).request("/owner/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: { providerName: string; baseURL?: string }[];
    };
    const anthropic = body.credentials.find(
      (c) => c.providerName === "anthropic",
    );
    expect(anthropic?.baseURL).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("12345");
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

  it("PUT on a tool-kind provider (granola) never echoes the secret and encrypts it at rest", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedCredentials } = credentialsDb({});
    const res = await buildApp(db).request("/owner/credentials/granola", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "grn-secret-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; kind: string };
    expect(body.kind).toBe("tool");
    expect(JSON.stringify(body)).not.toContain("grn-secret-token");

    const stored = (insertedCredentials[0] as { secret: string }).secret;
    expect(stored).not.toBe("grn-secret-token");
    expect(isEncryptedEnvelope(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("grn-secret-token");
  });

  it("PUT on an inference-kind provider (anthropic) stores the secret plaintext-compatible", async () => {
    // kind:"inference" rows must stay plaintext: Interchange reads
    // `credential.secret` raw at agent-launch time and cannot decrypt first.
    callerPrincipalId = "prn_owner";
    const { db, insertedCredentials } = credentialsDb({});
    await buildApp(db).request("/owner/credentials/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "sk-inference-secret" }),
    });
    const stored = (insertedCredentials[0] as { secret: string }).secret;
    expect(stored).toBe("sk-inference-secret");
    expect(isEncryptedEnvelope(stored)).toBe(false);
  });

  it("PUT UPDATE path (existing credential) also encrypts a tool-kind secret", async () => {
    callerPrincipalId = "prn_owner";
    const { db, updatedCredentials } = credentialsDb({
      providers: [{ id: "provider_1", name: "granola" }],
      credentials: [
        { id: "credential_1", providerId: "provider_1", updatedAt: new Date() },
      ],
    });
    await buildApp(db).request("/owner/credentials/granola", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "grn-rotated-token" }),
    });
    const stored = (updatedCredentials[0] as { secret: string }).secret;
    expect(isEncryptedEnvelope(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("grn-rotated-token");
  });

  // An existing provider row can carry metadata that predates the schema
  // (or was corrupted). The PUT response cast used to pass a wrongly-typed
  // `baseURL` straight through; parsing through `ProviderMetadataSchema` now
  // rejects it and the merge falls back to an empty base rather than
  // throwing.
  it("PUT tolerates malformed existing provider metadata without crashing", async () => {
    callerPrincipalId = "prn_owner";
    const { db, updatedCredentials } = credentialsDb({
      providers: [
        {
          id: "provider_1",
          name: "granola",
          metadata: { baseURL: 999 },
        },
      ],
      credentials: [
        { id: "credential_1", providerId: "provider_1", updatedAt: new Date() },
      ],
    });
    const res = await buildApp(db).request("/owner/credentials/granola", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: "grn-rotated-token",
        baseURL: "https://granola.example.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseURL?: string };
    expect(body.baseURL).toBe("https://granola.example.com");
    const stored = (updatedCredentials[0] as { secret: string }).secret;
    expect(isEncryptedEnvelope(stored)).toBe(true);
  });
});

// The workflow enablement toggle is grant CRUD on the org member role: enable
// writes an `allow`, disable writes a `deny`, and either way the prior
// workflow-run grant for the kind is replaced so exactly one row survives. The
// fake captures the delete + insert the route drives through setWorkflowRunGrant
// (which runs them in a transaction under a member-role row lock).
describe("owner workflow toggle route", () => {
  function workflowsDb() {
    const memberRole = [{ id: "rol_member" }];
    const insertedGrants: Record<string, unknown>[] = [];
    let deleteCalls = 0;

    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [] }) }),
      }),
      delete: () => ({
        where: () => {
          deleteCalls += 1;
          return Promise.resolve();
        },
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          insertedGrants.push(vals);
          return Promise.resolve();
        },
      }),
    };

    const db = {
      query: {
        role: {
          findFirst: async () => memberRole[0],
        },
      },
      transaction: async (fn: (t: unknown) => Promise<void>) => fn(tx),
      // recordAudit fires a best-effort insert on the outer db, not the tx.
      insert: () => ({ values: () => Promise.resolve() }),
    };
    return {
      db,
      insertedGrants,
      deleteCalls: () => deleteCalls,
    };
  }

  it("denies a plain member with 403", async () => {
    callerPrincipalId = "prn_member";
    const { db } = workflowsDb();
    const res = await buildApp(db).request("/owner/workflows/brief-builder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("PUT enable replaces the grant with an allow row", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedGrants, deleteCalls } = workflowsDb();
    const res = await buildApp(db).request("/owner/workflows/brief-builder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string; enabled: boolean }).toEqual({
      kind: "brief-builder",
      enabled: true,
    });
    expect(deleteCalls()).toBe(1);
    expect(insertedGrants).toHaveLength(1);
    expect(insertedGrants[0]).toMatchObject({
      resource: "workflow:brief-builder",
      action: "run",
      effect: "allow",
    });
  });

  it("PUT disable replaces the grant with a deny row", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedGrants, deleteCalls } = workflowsDb();
    const res = await buildApp(db).request("/owner/workflows/brief-builder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string; enabled: boolean }).toEqual({
      kind: "brief-builder",
      enabled: false,
    });
    expect(deleteCalls()).toBe(1);
    expect(insertedGrants).toHaveLength(1);
    expect(insertedGrants[0]).toMatchObject({
      resource: "workflow:brief-builder",
      action: "run",
      effect: "deny",
    });
  });

  it("PUT rejects a non-boolean body with 400", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = workflowsDb();
    const res = await buildApp(db).request("/owner/workflows/brief-builder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

// The org-wide demos toggle is grant CRUD on the org member role: enable writes
// an `allow` for `demos`/`view`, disable removes it. Demos are hidden by default
// (no grant present). These fakes capture what the route writes so the
// assertions pin the grant it produces, not the mock plumbing.
describe("owner demos routes", () => {
  function demosDb(opts: { allowGrant?: boolean } = {}) {
    const memberRole = [{ id: "rol_member" }];
    const grantRows = opts.allowGrant
      ? [
          {
            id: "grt_demos",
            resource: "demos",
            action: "view",
            effect: "allow",
            origin: "system",
            conditions: null,
            expiresAt: null,
            roleId: "rol_member",
            principalId: null,
          },
        ]
      : [];
    const insertedGrants: Record<string, unknown>[] = [];
    let deleteCalls = 0;

    const db = {
      query: {
        role: {
          findMany: async () => memberRole,
          findFirst: async () => memberRole[0],
        },
        grant: {
          findMany: async () => grantRows,
          findFirst: async () => (opts.allowGrant ? grantRows[0] : undefined),
        },
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          if ("effect" in vals) insertedGrants.push(vals);
          return Promise.resolve();
        },
      }),
      delete: () => ({
        where: () => {
          deleteCalls += 1;
          return Promise.resolve();
        },
      }),
    };
    return { db, insertedGrants, deleteCalls: () => deleteCalls };
  }

  it("denies a plain member with 403", async () => {
    callerPrincipalId = "prn_member";
    const { db } = demosDb();
    const res = await buildApp(db).request("/owner/demos");
    expect(res.status).toBe(403);
  });

  it("GET reports disabled when no demos allow grant exists", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterShowDemos = false;
    const { db } = demosDb({ allowGrant: false });
    const res = await buildApp(db).request("/owner/demos");
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { enabled: boolean; forcedByEnv: boolean },
    ).toEqual({
      enabled: false,
      forcedByEnv: false,
    });
  });

  it("GET reports enabled when the demos allow grant exists", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterShowDemos = false;
    const { db } = demosDb({ allowGrant: true });
    const res = await buildApp(db).request("/owner/demos");
    expect(
      (await res.json()) as { enabled: boolean; forcedByEnv: boolean },
    ).toEqual({
      enabled: true,
      forcedByEnv: false,
    });
  });

  it("GET reports forcedByEnv when SHOW_DEMOS is on, even without a grant", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterShowDemos = true;
    const { db } = demosDb({ allowGrant: false });
    const res = await buildApp(db).request("/owner/demos");
    expect(
      (await res.json()) as { enabled: boolean; forcedByEnv: boolean },
    ).toEqual({
      enabled: false,
      forcedByEnv: true,
    });
    ownerRouterShowDemos = false;
  });

  it("PUT enable writes an allow grant on demos/view", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterShowDemos = false;
    const { db, insertedGrants } = demosDb({ allowGrant: false });
    const res = await buildApp(db).request("/owner/demos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { enabled: boolean; forcedByEnv: boolean },
    ).toEqual({
      enabled: true,
      forcedByEnv: false,
    });
    expect(insertedGrants).toHaveLength(1);
    expect(insertedGrants[0]).toMatchObject({
      resource: "demos",
      action: "view",
      effect: "allow",
    });
  });

  it("PUT disable removes the allow grant", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterShowDemos = false;
    const { db, deleteCalls } = demosDb({ allowGrant: true });
    const res = await buildApp(db).request("/owner/demos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { enabled: boolean; forcedByEnv: boolean },
    ).toEqual({
      enabled: false,
      forcedByEnv: false,
    });
    expect(deleteCalls()).toBe(1);
  });

  it("PUT rejects a non-boolean body with 400", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = demosDb();
    const res = await buildApp(db).request("/owner/demos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

// Owner-managed feature grants (scheduler/triage/tasks-reconciler) replace the
// env-only kill switches: same deny-by-default grant CRUD shape as demos, one
// row per feature name.
describe("owner features routes", () => {
  function featuresDb(opts: { grantedFeatures?: string[] } = {}) {
    const memberRole = { id: "rol_member" };
    const granted = new Set(opts.grantedFeatures ?? []);
    const grantRows = [...granted].map((name) => ({
      id: `grt_${name}`,
      resource: `feature:${name}`,
      action: "enable",
      effect: "allow" as const,
      origin: "system",
      conditions: null,
      expiresAt: null,
      roleId: "rol_member",
      principalId: null,
    }));
    const insertedGrants: Record<string, unknown>[] = [];
    let deleteCalls = 0;

    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [] }) }),
      }),
      query: {
        grant: {
          findFirst: async () => grantRows[0],
        },
      },
      delete: () => ({
        where: () => {
          deleteCalls += 1;
          return Promise.resolve();
        },
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          insertedGrants.push(vals);
          return Promise.resolve();
        },
      }),
    };

    const db = {
      query: {
        role: {
          findMany: async () => [memberRole],
          findFirst: async () => memberRole,
        },
        grant: {
          findMany: async () => grantRows,
        },
      },
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
      insert: () => ({ values: () => Promise.resolve() }),
    };
    return { db, insertedGrants, deleteCalls: () => deleteCalls };
  }

  beforeEach(() => {
    ownerRouterFeatureEnvOverrides = {
      scheduler: false,
      triage: false,
      "tasks-reconciler": false,
    };
  });

  it("denies a plain member with 403", async () => {
    callerPrincipalId = "prn_member";
    const { db } = featuresDb();
    const res = await buildApp(db).request("/owner/features");
    expect(res.status).toBe(403);
  });

  it("GET lists the full catalog, disabled by default", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = featuresDb();
    const res = await buildApp(db).request("/owner/features");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: { name: string; enabled: boolean; forcedByEnv: boolean }[];
    };
    expect(body.features.map((f) => f.name).sort()).toEqual([
      "scheduler",
      "tasks-reconciler",
      "triage",
    ]);
    expect(body.features.every((f) => !f.enabled)).toBe(true);
    expect(body.features.every((f) => !f.forcedByEnv)).toBe(true);
  });

  it("GET reports a feature enabled when its member-role grant exists", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = featuresDb({ grantedFeatures: ["scheduler"] });
    const res = await buildApp(db).request("/owner/features");
    const body = (await res.json()) as {
      features: { name: string; enabled: boolean }[];
    };
    const scheduler = body.features.find((f) => f.name === "scheduler");
    const triage = body.features.find((f) => f.name === "triage");
    expect(scheduler?.enabled).toBe(true);
    expect(triage?.enabled).toBe(false);
  });

  it("GET reports forcedByEnv for a feature whose env override is on", async () => {
    callerPrincipalId = "prn_owner";
    ownerRouterFeatureEnvOverrides = {
      scheduler: false,
      triage: true,
      "tasks-reconciler": false,
    };
    const { db } = featuresDb();
    const res = await buildApp(db).request("/owner/features");
    const body = (await res.json()) as {
      features: { name: string; forcedByEnv: boolean }[];
    };
    const triage = body.features.find((f) => f.name === "triage");
    expect(triage?.forcedByEnv).toBe(true);
  });

  it("PUT enable writes an allow grant for the named feature", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedGrants } = featuresDb();
    const res = await buildApp(db).request("/owner/features/scheduler", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { name: string; enabled: boolean }).toEqual({
      name: "scheduler",
      enabled: true,
    });
    expect(insertedGrants).toHaveLength(1);
    expect(insertedGrants[0]).toMatchObject({
      resource: "feature:scheduler",
      action: "enable",
      effect: "allow",
    });
  });

  it("PUT disable removes the allow grant for the named feature", async () => {
    callerPrincipalId = "prn_owner";
    const { db, deleteCalls } = featuresDb({
      grantedFeatures: ["tasks-reconciler"],
    });
    const res = await buildApp(db).request("/owner/features/tasks-reconciler", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { name: string; enabled: boolean }).toEqual({
      name: "tasks-reconciler",
      enabled: false,
    });
    expect(deleteCalls()).toBe(1);
  });

  it("PUT rejects an unknown feature name with 404", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = featuresDb();
    const res = await buildApp(db).request("/owner/features/not-a-feature", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT rejects a non-boolean body with 400", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = featuresDb();
    const res = await buildApp(db).request("/owner/features/scheduler", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("owner capability toggle audit (CL-3356)", () => {
  // Grant writes go through db.transaction -> tx.insert; the fire-and-forget
  // recordAudit writes through the OUTER db.insert. Capturing both lets us
  // assert the logged action matches the grant effect actually written.
  function capabilitiesDb() {
    const memberRole = { id: "rol_member" };
    const grantWrites: Record<string, unknown>[] = [];
    const auditWrites: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [] }) }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          grantWrites.push(vals);
          return Promise.resolve();
        },
      }),
    };
    const db = {
      query: { role: { findFirst: async () => memberRole } },
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          auditWrites.push(vals);
          return Promise.resolve();
        },
      }),
    };
    return { db, grantWrites, auditWrites };
  }

  it("enabling logs grant_created/allow and writes an allow grant", async () => {
    callerPrincipalId = "prn_owner";
    const { db, grantWrites, auditWrites } = capabilitiesDb();
    const res = await buildApp(db).request("/owner/capabilities/linear", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(grantWrites[0]).toMatchObject({
      resource: "capability:linear",
      action: "use",
      effect: "allow",
    });
    expect(auditWrites[0]).toMatchObject({
      action: "grant_created",
      resource: "capability:linear",
    });
    expect(
      (auditWrites[0]?.detail as { effect?: string } | undefined)?.effect,
    ).toBe("allow");
  });

  it("disabling logs grant_revoked and writes a deny grant", async () => {
    callerPrincipalId = "prn_owner";
    const { db, grantWrites, auditWrites } = capabilitiesDb();
    const res = await buildApp(db).request("/owner/capabilities/attio", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(grantWrites[0]).toMatchObject({
      resource: "capability:attio",
      action: "use",
      effect: "deny",
    });
    expect(auditWrites[0]).toMatchObject({
      action: "grant_revoked",
      resource: "capability:attio",
    });
  });

  it("rejects an unknown provider with 404", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = capabilitiesDb();
    const res = await buildApp(db).request("/owner/capabilities/notreal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── CL-3634: owner role delegation ─────────────────────────────────
describe("owner member role delegation", () => {
  beforeEach(() => {
    ownerRoleId = "rol_owner";
    ownerDemoteResult = "ok";
    membersPrincipalExists = true;
    tenantMembers = [
      {
        id: "prn_owner",
        refId: "u_owner",
        displayName: "Owner",
        isOwner: true,
      },
      { id: "prn_x", refId: "u_x", displayName: "Member X", isOwner: false },
    ];
    assignRole.mockClear();
    demoteFromOwner.mockClear();
  });

  it("denies a non-owner with 403 on list/promote/demote", async () => {
    callerPrincipalId = "prn_member";
    const { db } = membersDb();
    const list = await buildApp(db).request("/owner/members");
    expect(list.status).toBe(403);
    const promote = await buildApp(db).request("/owner/members/prn_x/promote", {
      method: "POST",
    });
    expect(promote.status).toBe(403);
    const demote = await buildApp(db).request("/owner/members/prn_x/demote", {
      method: "POST",
    });
    expect(demote.status).toBe(403);
    expect(assignRole).not.toHaveBeenCalled();
    expect(demoteFromOwner).not.toHaveBeenCalled();
  });

  it("lists members with owner-role status for an owner caller", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = membersDb();
    const res = await buildApp(db).request("/owner/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { id: string; isOwner: boolean }[];
    };
    expect(body.members).toHaveLength(2);
    expect(body.members.find((m) => m.id === "prn_owner")?.isOwner).toBe(true);
  });

  it("promotes a member to owner and audits role_assigned", async () => {
    callerPrincipalId = "prn_owner";
    const { db, auditWrites } = membersDb();
    const res = await buildApp(db).request("/owner/members/prn_x/promote", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(assignRole).toHaveBeenCalledTimes(1);
    expect(assignRole.mock.calls[0]?.[3]).toBe("rol_owner");
    expect(auditWrites[0]).toMatchObject({
      action: "role_assigned",
      resource: "role:owner",
      targetPrincipalId: "prn_x",
    });
  });

  it("demotes an owner and audits role_removed", async () => {
    callerPrincipalId = "prn_owner";
    const { db, auditWrites } = membersDb();
    const res = await buildApp(db).request("/owner/members/prn_x/demote", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(demoteFromOwner).toHaveBeenCalledTimes(1);
    expect(auditWrites[0]).toMatchObject({
      action: "role_removed",
      resource: "role:owner",
      targetPrincipalId: "prn_x",
    });
  });

  it("refuses self-demotion with 400 and writes no role change", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = membersDb();
    const res = await buildApp(db).request("/owner/members/prn_owner/demote", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(demoteFromOwner).not.toHaveBeenCalled();
  });

  it("refuses demoting the last remaining owner with 400", async () => {
    callerPrincipalId = "prn_owner";
    ownerDemoteResult = "last-owner";
    const { db, auditWrites } = membersDb();
    const res = await buildApp(db).request("/owner/members/prn_x/demote", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(auditWrites).toHaveLength(0);
  });

  it("404s promoting an unknown principal and writes no role", async () => {
    callerPrincipalId = "prn_owner";
    membersPrincipalExists = false;
    const { db } = membersDb();
    const res = await buildApp(db).request("/owner/members/prn_ghost/promote", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(assignRole).not.toHaveBeenCalled();
  });
});
