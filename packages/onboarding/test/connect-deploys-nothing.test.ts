// "Connecting should deploy nothing" (CL-6457), asserted at the route
// layer. The live repro: pasting a key sat on "Connecting…" for 2+
// minutes because `POST /complete` deployed five default workflows —
// ~20s each — before it answered. The fix is structural, so the test is
// too: the follow-up work is handed in as a kick seam that takes five
// seconds and records when it ran, and the route has to answer long
// before it could possibly have waited on that. A route that ever awaits
// a deploy again fails here on the clock, not on a mock's call count
// alone. CL-7586 deleted the pending-seed drain the kick used to wake:
// the kick now names the tenant for the desired-state reconcile, and no
// row is parked anywhere.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  DEFAULT_WORKFLOWS,
  SETUP_AGENT_ASSET_NAME,
  inferenceCredentialName,
} from "@corbits/seeding";
import { createOnboardingRoutes } from "../src/routes";

const TENANT_ID = "ten_1";
const PRINCIPAL_ID = "prn_1";
const TENANT_SLUG = "user-1-user1";
const TENANT_DOMAIN = "user-1-user1.bench.local";
const ALL_WORKFLOWS = DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName);

function asUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
    await next();
  };
}

/** A hub that answers only the reads the fast half performs. Any deploy
 * traffic would have to go somewhere else entirely — and the deploy seam
 * below proves it never even starts. */
function fakeHub(
  args: {
    seededWorkflows?: string[];
    tenantSlug?: string;
    inferenceCredential?: boolean;
  } = {},
) {
  const seeded = args.seededWorkflows ?? [];
  const hub = new Hono();
  const requests: string[] = [];
  hub.use("*", async (c, next) => {
    requests.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
    await next();
  });
  hub.get("/api/me/principals", (c) =>
    c.json({
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "user_1's workbench",
          tenantSlug: args.tenantSlug ?? TENANT_SLUG,
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    }),
  );
  hub.get("/api/tenants/:id", (c) =>
    c.json({
      id: TENANT_ID,
      name: "user_1's workbench",
      slug: TENANT_SLUG,
      domain: TENANT_DOMAIN,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  hub.get("/api/tenants/:id/assets", (c) => {
    if (c.req.query("kind") === "package-registry") {
      // The corbits-tools registry is seeded in every state this suite
      // models — readiness now also requires resolvable tool packages.
      return c.json([
        {
          id: "ast_registry",
          tenantId: TENANT_ID,
          kind: "package-registry",
          name: "corbits-tools",
          displayName: null,
          creatorPrincipalId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          origin: { tenantId: TENANT_ID, direct: true },
        },
      ]);
    }
    return c.json(
      seeded.map((name, index) => ({
        id: `ast_${index}`,
        tenantId: TENANT_ID,
        kind: "workflow",
        name,
        displayName: name,
        creatorPrincipalId: PRINCIPAL_ID,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        origin: { tenantId: TENANT_ID, direct: true },
      })),
    );
  });
  hub.get("/api/tenants/:id/assets/ast_registry/tarballs", (c) =>
    c.json([
      {
        filename: "corbits-memory-tools-0.0.4.tgz",
        size: 1,
        integrity: "sha512-x",
      },
    ]),
  );
  hub.get("/api/tenants/:id/credentials", (c) =>
    c.json({
      data: args.inferenceCredential === true ? [activeCredentialRow()] : [],
      nextCursor: null,
    }),
  );
  hub.get("/api/tenants/:id/skills/:name", (c) =>
    c.json({ name: c.req.param("name") }),
  );
  hub.get("/api/tenants/:id/workflows/deployments", (c) =>
    c.json(
      seeded.map((_name, index) => ({
        definitionAssetId: `ast_${index}`,
        status: "deployed",
      })),
    ),
  );
  return { hub, requests };
}

/** The one row `/complete-setup`'s credential check looks for: an
 * active credential under the name `seedCatalog` persists inference
 * keys as. */
function activeCredentialRow() {
  return {
    id: "cre_1",
    tenantId: TENANT_ID,
    providerId: "prv_1",
    name: inferenceCredentialName("anthropic"),
    type: "api_key",
    status: "active",
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function routeDeps(args: {
  hubUrl: string;
  onKick?: (tenantId: string) => void;
}) {
  return {
    hubUrl: args.hubUrl,
    // This suite never exercises the genesis-or-join join path; the
    // stub satisfies the required tenancy wiring without a DB.
    tenancy: {
      countUsers: async () => 0,
      countTenants: async () => 0,
      findRootTenant: async () => null,
      addActiveMember: async () => {
        throw new Error("this suite never exercises the join path");
      },
    },
    defaultTenantSlug: "workbench",
    pushWorkflow: async () => ({
      outcome: "pushed" as const,
      commitSha: "a".repeat(40),
    }),
    log: () => undefined,
    testAndPersistCredentialFn: async () => ({
      kind: "connected" as const,
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: PRINCIPAL_ID,
      tenantDomain: TENANT_DOMAIN,
    }),
    // CL-7586 deleted the pending-seed drain: the route hands follow-up
    // work to the desired-state reconcile as a fire-and-forget kick
    // naming the tenant. Tests hand in slow kicks to prove the route
    // answers without waiting on them.
    ...(args.onKick === undefined
      ? {}
      : {
          desiredStateKick: ({ tenantId }: { tenantId: string }) => {
            args.onKick?.(tenantId);
          },
        }),
  };
}

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser());
  app.route("/api/onboarding", routes);
  return app;
}

describe("POST /complete — connecting deploys nothing", () => {
  test("answers in a moment even when the kicked reconcile would take five seconds", async () => {
    const { hub, requests } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    let kickStarted = false;
    let kickFinished = false;
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            onKick: () => {
              kickStarted = true;
              void new Promise((resolve) => setTimeout(resolve, 5_000)).then(
                () => {
                  kickFinished = true;
                },
              );
            },
          }),
        ),
      );

      const startedAt = Date.now();
      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_000);
      // The response never waited on the kicked reconcile — the whole
      // point: the kick started, but its five seconds are still running.
      expect(kickStarted).toBe(true);
      expect(kickFinished).toBe(false);
      // And nothing deploy-shaped was even attempted against the hub.
      expect(
        requests.filter(
          (line) =>
            line.includes("/workflows/deployments") && line.startsWith("POST"),
        ),
      ).toEqual([]);
      expect(
        requests.filter((line) =>
          line.startsWith("POST /api/tenants/ten_1/assets"),
        ),
      ).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("reports the bench as provisioning, naming the agents still to come", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}` }),
        ),
      );

      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        deployed: string[];
        pending: string[];
      };

      expect(body.kind).toBe("provisioning");
      expect(body.tenantSlug).toBe(TENANT_SLUG);
      expect(body.deployed).toEqual([]);
      expect(body.pending).toEqual(ALL_WORKFLOWS);
    } finally {
      server.stop(true);
    }
  });

  test("kicks the desired-state reconcile for the bench instead of parking a row", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const kickedTenants: string[] = [];
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            onKick: (tenantId) => {
              kickedTenants.push(tenantId);
            },
          }),
        ),
      );

      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      // No row is parked anywhere: the reconcile learns the tenant from
      // the kick's arguments, not from a drain table.
      expect(kickedTenants).toEqual([TENANT_ID]);
    } finally {
      server.stop(true);
    }
  });

  test("an already-provisioned bench reconnecting reports ready, with nothing left pending", async () => {
    const { hub } = fakeHub({ seededWorkflows: ALL_WORKFLOWS });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const kickedTenants: string[] = [];
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            onKick: (tenantId) => {
              kickedTenants.push(tenantId);
            },
          }),
        ),
      );

      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as {
        kind: string;
        pending: string[];
      };

      expect(body.kind).toBe("ready");
      expect(body.pending).toEqual([]);
      // Nothing left to reconcile, so no kick either.
      expect(kickedTenants).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});

describe("GET /provisioning-status", () => {
  test.each([
    ["", 400],
    ["?tenantId=", 400],
    ["?tenantId=someone-elses-bench", 403],
  ])(
    "rejects invalid or inaccessible selected benches: %s",
    async (query, expectedStatus) => {
      const { hub, requests } = fakeHub();
      const server = Bun.serve({ port: 0, fetch: hub.fetch });
      try {
        const app = mountAuthenticated(
          createOnboardingRoutes(
            routeDeps({ hubUrl: `http://localhost:${server.port}` }),
          ),
        );
        const response = await app.request(
          `/api/onboarding/provisioning-status${query}`,
        );
        expect(response.status).toBe(expectedStatus);
        expect(requests.some((request) => request.includes("/assets"))).toBe(
          false,
        );
      } finally {
        server.stop(true);
      }
    },
  );

  // CL-7074 narrowed DEFAULT_WORKFLOWS to just the setup agent, so the
  // "some deployed, some still pending" progress bar this route used to
  // report (CL-6462, when the default set was echo/assistant/
  // workbench-digest) can no longer happen for a real bench: with one
  // default workflow, provisioning-status is binary — nothing deployed
  // yet (`provisioning`, setup agent not ready) or fully deployed
  // (`ready`). This test replaces the old two-test "partial progress"
  // coverage with that binary reality; `setupAgentReady` and
  // `kind: "ready"` are asserted at their other call sites below.
  test("reports provisioning, with the setup agent not yet ready, before she deploys", async () => {
    const { hub } = fakeHub({ seededWorkflows: [] });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}` }),
        ),
      );

      const response = await app.request(
        `/api/onboarding/provisioning-status?tenantId=${TENANT_ID}`,
      );
      const body = (await response.json()) as {
        kind: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
      };

      expect(response.status).toBe(200);
      expect(body.kind).toBe("provisioning");
      expect(body.setupAgentReady).toBe(false);
      expect(body.deployed).toEqual([]);
      expect(body.pending).toEqual(ALL_WORKFLOWS);
    } finally {
      server.stop(true);
    }
  });

  test("a bench whose other workflows landed first is not reported as chat-ready", async () => {
    const others = ALL_WORKFLOWS.filter(
      (name) => name !== SETUP_AGENT_ASSET_NAME,
    );
    const { hub } = fakeHub({ seededWorkflows: others });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}` }),
        ),
      );

      const response = await app.request(
        `/api/onboarding/provisioning-status?tenantId=${TENANT_ID}`,
      );
      const body = (await response.json()) as { setupAgentReady: boolean };

      expect(body.setupAgentReady).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("reports readiness for a selected shared bench without a personal bench", async () => {
    const { hub } = fakeHub({
      seededWorkflows: ALL_WORKFLOWS,
      tenantSlug: "workbench",
    });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}` }),
        ),
      );

      const response = await app.request(
        `/api/onboarding/provisioning-status?tenantId=${TENANT_ID}`,
      );
      const body = (await response.json()) as { kind: string };

      expect(body.kind).toBe("ready");
    } finally {
      server.stop(true);
    }
  });
});

describe("POST /complete-setup — kicks instead of deploying", () => {
  test("kicks the reconcile and answers provisioning without waiting on it", async () => {
    // The key is already persisted under the setup catalog's name, so
    // the route finds something to reconcile toward; the workflows are
    // not deployed yet, so the answer is provisioning either way.
    const { hub } = fakeHub({ inferenceCredential: true });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    let kickStarted = false;
    let kickFinished = false;
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            onKick: () => {
              kickStarted = true;
              void new Promise((resolve) => setTimeout(resolve, 5_000)).then(
                () => {
                  kickFinished = true;
                },
              );
            },
          }),
        ),
      );

      const startedAt = Date.now();
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = (await response.json()) as { kind: string };

      expect(response.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(body.kind).toBe("provisioning");
      // Same structural guarantee as /complete: the kicked reconcile
      // started, but the route never waited on its five seconds.
      expect(kickStarted).toBe(true);
      expect(kickFinished).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("still reports unseeded when there is no key to reconcile toward yet", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}` }),
        ),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });
      const body = (await response.json()) as { kind: string };

      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });
});
