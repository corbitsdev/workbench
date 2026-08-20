// The slow half's own route: `POST /complete-setup` is what actually
// runs `ensureSeeded` — the workflow-deploy step the OAuth callback
// routes never run inline (see `complete-credential.ts`'s module
// comment and `openrouter-connect-routes.test.ts`'s "never triggers a
// workflow deploy call" coverage of the callback side). This is the
// onboarding page's own follow-up call after landing, and it has to
// answer three cases correctly: already seeded (no work, no pending
// row needed), unseeded with nothing to seed with yet (not an error),
// and unseeded with a just-connected credential's pending row to
// finish the job — the last case run twice at once must never
// double-deploy.
//
// CL-6031 moved the pending credential off the browser: what used to
// be a sealed HttpOnly cookie is now a row in
// `createInMemoryPendingSeedStore` (the same store shape
// `createDrizzlePendingSeedStore` gives Postgres — see
// `../src/pending-seed.test.ts` for that logic's own direct coverage),
// written by calling `store.put(...)` the way the OAuth callback would,
// instead of round-tripping a cookie header.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS } from "@workbench/hub-client";
import { createOnboardingRoutes } from "../src/routes";
import {
  createInMemoryPendingSeedStore,
  type PendingSeedStore,
} from "../src/pending-seed";

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

async function withPendingSeed(
  store: PendingSeedStore,
  args: { userId?: string; ttlMs?: number } = {},
): Promise<void> {
  await store.put(
    {
      userId: args.userId ?? "user_1",
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      tenantDomain: TENANT_DOMAIN,
      provider: "openrouter",
      apiKey: "sk-or-v1-minted",
    },
    args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {},
  );
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
        pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
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
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
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

  test("an already fully seeded bench reports seeded without needing a pending row", async () => {
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
          status: "deployed",
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
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      // No pending-seed row at all — an already-seeded bench must
      // answer from the read alone, no pending row required.
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

  test("unseeded with no pending row reports unseeded, not an error", async () => {
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
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
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

  test("unseeded with a valid pending row runs ensureSeeded and reports seeded", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
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
          pendingSeedStore,
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
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        workflows: string[];
      };
      expect(body).toEqual({
        kind: "seeded",
        tenantId: TENANT_ID,
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
      // The pending row has done its job — it must not sit in the
      // store for the rest of its ten-minute TTL once seeding actually
      // succeeds.
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench also clears a stray pending row, not just the freshly-run case", async () => {
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
          status: "deployed",
        })),
      ),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          pendingSeedStore,
        }),
      );

      // A concurrent call already finished seeding and its own logic
      // cleared the row; this request just happens to have written its
      // own pending row moments earlier — exactly what a second
      // in-flight request from a double effect fire would look like
      // from the server's perspective.
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("seeded");
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("an expired pending row is cleared rather than left to linger unused", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      await withPendingSeed(pendingSeedStore, { ttlMs: -1 });
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          pendingSeedStore,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("a pending row written for a different user is invisible to this session", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      await withPendingSeed(pendingSeedStore, { userId: "someone_else" });
      let ensureSeededCalls = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          pendingSeedStore,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      expect(ensureSeededCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("two overlapping calls reading the same pending row never double-deploy", async () => {
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
          status: "deployed",
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
    hub.get(`/api/tenants/${TENANT_ID}/skills/:name`, (c) => c.json({}, 404));
    hub.post(`/api/tenants/${TENANT_ID}/skills`, (c) => c.json({}, 201));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/definitions`, (c) =>
      c.json({ data: [], nextCursor: null }, 200),
    );
    hub.get(`/api/tenants/${TENANT_ID}/routines`, (c) =>
      c.json({ items: [] }, 200),
    );
    // The corbits-tools registry publish `seedTenant` now runs ahead of
    // any workflow deploy: stands in for the real tarball-upload REST
    // route so that publish succeeds without asserting anything about
    // its content — this test's own assertions are about deploy
    // idempotency, not about publishing.
    hub.put(
      `/api/tenants/${TENANT_ID}/assets/:assetId/tarballs/:filename`,
      (c) => c.json({ commit: "deadbeef", integrity: "sha512-test" }, 200),
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
          status: "deployed",
          createdAt: TIMESTAMP,
        },
        201,
      );
    });

    hub.get(`/api/tenants/${TENANT_ID}/assets/:assetId/tarballs`, (c) =>
      c.json([], 200),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          pendingSeedStore,
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const [first, second] = await Promise.all([
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { kind: string };
      const secondBody = (await second.json()) as { kind: string };
      expect(firstBody.kind).toBe("seeded");
      expect(secondBody.kind).toBe("seeded");

      // Both requests share one seed operation, so nothing is planted
      // twice. One extra asset beyond the workflow set is the tenant's own
      // corbits-tools package-registry asset, which `seedTenant`
      // publishes ahead of any workflow deploy and which shares this
      // fake hub's one `/assets` create route with the workflow assets.
      expect(assetCreatePosts).toBe(DEFAULT_WORKFLOWS.length + 1);
      expect(deploymentCreatePosts).toBe(DEFAULT_WORKFLOWS.length);
      expect(assets.length).toBe(DEFAULT_WORKFLOWS.length + 1);
      expect(deployments.length).toBe(DEFAULT_WORKFLOWS.length);
    } finally {
      server.stop(true);
    }
  });

  // CL-6264: a sidecar-unavailable deploy must not fail this route —
  // durable state (credential, tenant, grants, assets) is already
  // intact — and the pending row must survive so a later reload's call
  // to this same route can finish the deferred workflows once the
  // sidecar is back.
  test("a sidecar-unavailable deploy reports the pending kind and keeps the pending row for the next retry", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => "pushed",
          log: () => undefined,
          pendingSeedStore,
          ensureSeededFn: async () => ({
            kind: "seeded-pending-agents",
            deployed: ["echo"],
            pending: ["assistant"],
            message:
              "Your workbench is ready — agents will come online shortly.",
          }),
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        deployed: string[];
        pending: string[];
        message: string;
      };
      expect(body).toEqual({
        kind: "seeded-pending-agents",
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        deployed: ["echo"],
        pending: ["assistant"],
        message: "Your workbench is ready — agents will come online shortly.",
      });

      // Not fully seeded yet — the row must still be there for the next
      // reload's retry, not cleared the way a full `seeded` result
      // clears it.
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});
