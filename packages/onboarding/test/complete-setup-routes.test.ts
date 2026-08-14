// The slow half's own route: `POST /complete-setup` is what actually
// runs `ensureSeeded` — the workflow-deploy step the OAuth callback
// routes never run inline (see `complete-credential.ts`'s module
// comment and `openrouter-connect-routes.test.ts`'s "never triggers a
// workflow deploy call" coverage of the callback side). This is the
// onboarding page's own follow-up call after landing, and it has to
// answer three cases correctly: already seeded (no work, no pending
// token needed), unseeded with nothing to seed with yet (not an error),
// and unseeded with a just-connected credential's pending token to
// finish the job — the last case run twice at once must never
// double-deploy.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS } from "@workbench/hub-client";
import { createOnboardingRoutes } from "../src/routes";
import { sealPendingSeed, PENDING_SEED_COOKIE } from "../src/pending-seed";

const TEST_KEY = Buffer.alloc(32, 21);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const TENANT_ID = "ten_1";
const PRINCIPAL_ID = "prn_1";
const TENANT_SLUG = "user-1-user1";
const TENANT_DOMAIN = "user-1-user1.bench.local";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function asUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
    await next();
  };
}

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser());
  app.route("/api/onboarding", routes);
  return app;
}

function principalsRoute(hub: Hono) {
  hub.get("/api/me/principals", (c) =>
    c.json({
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "user_1's workbench",
          tenantSlug: TENANT_SLUG,
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    }),
  );
  hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
    c.json({
      id: TENANT_ID,
      name: "user_1's workbench",
      slug: TENANT_SLUG,
      domain: TENANT_DOMAIN,
      parentId: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }),
  );
}

async function pendingSeedCookie(cipher: CredentialCipher): Promise<string> {
  const token = await sealPendingSeed(cipher, {
    userId: "user_1",
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    tenantDomain: TENANT_DOMAIN,
    provider: "openrouter",
    apiKey: "sk-or-v1-minted",
  });
  return `${PENDING_SEED_COOKIE}=${token}`;
}

describe("POST /complete-setup", () => {
  test("requires authentication", async () => {
    const app = new Hono<AppEnv>();
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({
        hubUrl: "https://bench.example.com",
        pushWorkflow: async () => "pushed",
        log: () => undefined,
      }),
    );

    const response = await app.request("/api/onboarding/complete-setup", {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  test("no personal bench yet reports 409, not a fabricated seed", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("no_personal_bench");
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench reports seeded without needing a pending token", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((_workflow, index) => ({
          definitionAssetId: `ast_${index}`,
          status: "active",
        })),
      ),
    );
    let ensureSeededCalls = 0;
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      // No pending-seed cookie at all — an already-seeded bench must
      // answer from the read alone, no pending token required.
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        workflows: string[];
      };
      expect(body.kind).toBe("seeded");
      expect(body.tenantSlug).toBe(TENANT_SLUG);
      expect(body.workflows.sort()).toEqual(
        DEFAULT_WORKFLOWS.map((w) => w.assetName).sort(),
      );
      expect(ensureSeededCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("unseeded with no pending token reports unseeded, not an error", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });

  test("unseeded with a valid pending token runs ensureSeeded and reports seeded", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const cipher = testCipher();
    try {
      const ensureSeededCalls: {
        provider: string;
        apiKey: string;
        tenant: { tenantId: string };
      }[] = [];
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          credentialCipher: cipher,
          ensureSeededFn: async (args) => {
            ensureSeededCalls.push({
              provider: args.provider,
              apiKey: args.apiKey,
              tenant: { tenantId: args.tenant.tenantId },
            });
            return { kind: "seeded", workflows: ["echo", "assistant"] };
          },
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
        headers: { cookie: await pendingSeedCookie(cipher) },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        workflows: string[];
      };
      expect(body).toEqual({
        kind: "seeded",
        tenantSlug: TENANT_SLUG,
        workflows: ["echo", "assistant"],
      });
      expect(ensureSeededCalls).toEqual([
        {
          provider: "openrouter",
          apiKey: "sk-or-v1-minted",
          tenant: { tenantId: TENANT_ID },
        },
      ]);
      // The sealed key has done its job — it must not sit in the
      // browser for the rest of its ten-minute TTL once seeding
      // actually succeeds.
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${PENDING_SEED_COOKIE}=;`);
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench also clears a stray pending cookie, not just the freshly-run case", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((_workflow, index) => ({
          definitionAssetId: `ast_${index}`,
          status: "active",
        })),
      ),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const cipher = testCipher();
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          credentialCipher: cipher,
        }),
      );

      // A concurrent call already finished seeding and its own response
      // cleared the cookie in the browser's real cookie jar; this
      // request just happens to still be carrying the stale header —
      // exactly what a second in-flight request from a double effect
      // fire would look like from the server's perspective.
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
        headers: { cookie: await pendingSeedCookie(cipher) },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("seeded");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${PENDING_SEED_COOKIE}=;`);
    } finally {
      server.stop(true);
    }
  });

  test("an expired pending token is cleared rather than left to linger unused", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const cipher = testCipher();
    try {
      const expiredToken = await sealPendingSeed(
        cipher,
        {
          userId: "user_1",
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          tenantDomain: TENANT_DOMAIN,
          provider: "openrouter",
          apiKey: "sk-or-v1-minted",
        },
        { ttlMs: -1 },
      );
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          credentialCipher: cipher,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
        headers: { cookie: `${PENDING_SEED_COOKIE}=${expiredToken}` },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${PENDING_SEED_COOKIE}=;`);
    } finally {
      server.stop(true);
    }
  });

  test("a pending token sealed for a different user is rejected as unseeded", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const cipher = testCipher();
    try {
      const token = await sealPendingSeed(cipher, {
        userId: "someone_else",
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        tenantDomain: TENANT_DOMAIN,
        provider: "openrouter",
        apiKey: "sk-or-v1-minted",
      });
      let ensureSeededCalls = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          credentialCipher: cipher,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
        headers: { cookie: `${PENDING_SEED_COOKIE}=${token}` },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      expect(ensureSeededCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("two overlapping calls reading the same pending token never double-deploy", async () => {
    // The concurrency guarantee the task calls for: two "finish setup"
    // requests racing (a double effect fire, a retried fetch) must both
    // land on `seeded` without planting anything twice. Runs the real
    // `ensureSeeded` (no stub) against a stateful fake hub — the same
    // ensure-then-create tolerance `seedTenant` already has everywhere
    // else, exercised here through the actual route.
    const grants: { resource: string; action: string }[] = [];
    const assets: { name: string; id: string }[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    let assetCreatePosts = 0;
    let deploymentCreatePosts = 0;

    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        assets.map((a) => ({
          id: a.id,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: a.name,
          displayName: a.name,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        deployments.map((d) => ({
          id: d.id,
          tenantId: TENANT_ID,
          definitionAssetId: d.definitionAssetId,
          status: "active",
          createdAt: TIMESTAMP,
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/grants`, (c) =>
      c.json({
        data: grants.map((g, index) => ({
          id: `grt_${index}`,
          tenantId: TENANT_ID,
          resource: g.resource,
          action: g.action,
          effect: "allow",
          principalId: PRINCIPAL_ID,
          origin: "creator",
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        })),
        nextCursor: null,
      }),
    );
    hub.post(`/api/tenants/${TENANT_ID}/grants`, async (c) => {
      const g = (await c.req.json()) as { resource: string; action: string };
      grants.push({ resource: g.resource, action: g.action });
      return c.json({}, 201);
    });
    hub.post(`/api/tenants/${TENANT_ID}/assets`, async (c) => {
      const body = (await c.req.json()) as { name: string };
      const existing = assets.find((a) => a.name === body.name);
      if (existing) return c.json({}, 409);
      assetCreatePosts += 1;
      const id = `ast_${body.name}`;
      assets.push({ name: body.name, id });
      return c.json(
        {
          id,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: body.name,
          displayName: body.name,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        201,
      );
    });
    hub.post(`/api/tenants/${TENANT_ID}/git-tokens`, (c) =>
      c.json({ id: "tok_1", secret: "s3cret" }, 201),
    );
    hub.post(`/api/tenants/${TENANT_ID}/workflows/deployments`, async (c) => {
      deploymentCreatePosts += 1;
      const body = (await c.req.json()) as { assetId: string };
      const id = `dep_${body.assetId}`;
      deployments.push({ definitionAssetId: body.assetId, id });
      return c.json(
        {
          id,
          tenantId: TENANT_ID,
          definitionAssetId: body.assetId,
          status: "active",
          createdAt: TIMESTAMP,
        },
        201,
      );
    });

    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const cipher = testCipher();
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          credentialCipher: cipher,
        }),
      );
      const cookie = await pendingSeedCookie(cipher);

      const [first, second] = await Promise.all([
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
          headers: { cookie },
        }),
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
          headers: { cookie },
        }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { kind: string };
      const secondBody = (await second.json()) as { kind: string };
      expect(firstBody.kind).toBe("seeded");
      expect(secondBody.kind).toBe("seeded");

      // Every ensure-then-create helper hit its 409 branch on the
      // overlapping call — nothing was ever planted twice.
      expect(assetCreatePosts).toBe(DEFAULT_WORKFLOWS.length);
      expect(deploymentCreatePosts).toBe(DEFAULT_WORKFLOWS.length);
      expect(assets.length).toBe(DEFAULT_WORKFLOWS.length);
      expect(deployments.length).toBe(DEFAULT_WORKFLOWS.length);
    } finally {
      server.stop(true);
    }
  });
});
