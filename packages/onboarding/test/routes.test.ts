// Route-level error-envelope coverage: a failure inside a route must
// never reach the caller as a bare, unhandled 500 — it should come back as
// the same `{ error: { code, userMessage, refId } }` envelope every other
// hub route uses, so the web layer can tell "nothing to do" apart from
// "this broke" instead of both looking like silence.

import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createOnboardingRoutes } from "../src/routes";
import { testAndPersistCredential } from "../src/complete-credential";
import { createProviderHealthStore } from "@corbits/connections/provider-health";
import { HubApiError } from "@corbits/hub-api-client";

const asUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", { id: "user_1", email: "alice@example.com" } as never);
  await next();
};

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser);
  app.route("/", routes);
  return app;
}

describe("POST /complete", () => {
  test("an anonymous request is rejected before anything is seeded", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
    });

    const response = await routes.request("/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        apiKey: "sk-ant-whatever",
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("unauthorized");
  });

  test("a missing provider is rejected with a specific message, no network call made", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-whatever" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
  });

  // CL-6092: onboarding's own credential flow is the zero-provider fix
  // path the shell banner routes to ("Fix it" → onboarding when nothing
  // is connected yet). Without this wiring, a successful connect through
  // *this* route left the stale needs-attention record standing, so the
  // banner never went away even though the fix worked.
  test("a successful connect clears a stale needs_attention record for the connected provider", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report("tnt_own", "anthropic", "credential_failure");
    // A durable credential is the whole trigger for clearing the record,
    // so the connect only has to get past the fast half. The bench still
    // has every default workflow to deploy — this hub reports none of
    // them present — which is exactly the state the clear must survive.
    const hub = new Hono();
    hub.get("/api/tenants/:id/assets", (c) => c.json([]));
    hub.get("/api/tenants/:id/workflows/deployments", (c) => c.json([]));
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        providerHealth,
        testAndPersistCredentialFn: async () => ({
          kind: "connected",
          tenantId: "tnt_own",
          tenantSlug: "alice",
          principalId: "prn_own",
          tenantDomain: "alice.bench.local",
        }),
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-good" }),
      });

      expect(response.status).toBe(200);
      expect(providerHealth.get("tnt_own", "anthropic")).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("an invalid credential never clears the needs_attention record", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report("tnt_own", "anthropic", "credential_failure");
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      providerHealth,
      testAndPersistCredentialFn: async () => ({
        kind: "invalid-credential",
        message: "the key was rejected",
      }),
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-bad" }),
    });

    expect(response.status).toBe(422);
    expect(providerHealth.get("tnt_own", "anthropic")?.status).toBe(
      "needs_attention",
    );
  });

  // CL-6457 moved partial-deploy convergence off this route entirely,
  // CL-7586 deleted the pending-seed drain, and CL-8085 deleted the
  // server-side desired-state kick with it: `/complete` neither deploys
  // anything nor kicks anything, so there is no half-finished deploy for
  // it to report. The client's needs-list convergence
  // (`apps/web/src/needs-converge.ts`) drives the deploy from the
  // browser; the reconcile it replaces is covered by
  // `./desired-state-reconcile.test.ts` ("a non-sidecar failure reports
  // failed, and a re-run can converge").

  test("a non-sidecar failure during setup still fails loudly with the existing 500 envelope", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      testAndPersistCredentialFn: async () => {
        throw new Error("the hub rejected deployment with status 500");
      },
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-good" }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("credential_setup_failed");
  });

  // CL-6360: a `HubApiError` whose message names an absolute path on the
  // hub's own disk must never reach the client; only a fixed consumer
  // sentence and a refId may. The payload here is a historical
  // freshness-check wrap; signup no longer packs, but the redaction
  // still applies to any seed/setup HubApiError that names a path.
  test("a HubApiError naming an absolute file path never reaches the client", async () => {
    const lines: string[] = [];
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      logError: (line) => lines.push(line),
      testAndPersistCredentialFn: async () => {
        throw new HubApiError(
          "publishing the corbits-tools package-registry asset failed: " +
            "tool-package freshness: @corbits/memory-tools@1.2.0 changed " +
            "src/ without bumping version.\n  /Users/alice/abklabs/workbench/packages/memory-tools",
          "check the hub logs for the underlying failure, then re-run: workbench seed",
        );
      },
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-good" }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("credential_setup_failed");
    expect(body.error.userMessage).not.toContain("/Users/");
    expect(body.error.userMessage).not.toContain("workbench seed");
    expect(typeof body.error.refId).toBe("string");
    expect(body.error.refId.length).toBeGreaterThan(0);
    // The raw detail is still recoverable from the hub log, tagged with
    // the same refId the client got back.
    expect(
      lines.some(
        (line) =>
          line.includes(body.error.refId) &&
          line.includes("/Users/alice/abklabs/workbench/packages/memory-tools"),
      ),
    ).toBe(true);
  });
});

// CL-7506: the connect route runs the real fast half — which resolves the
// tenant through findPersonalTenant with the fallback flag — so a seeded
// admin whose only membership is the root bench (slug "acme", never the
// computed "alice-user1") must connect, not 409 no_personal_bench. The
// persistence half is stubbed at its own seams; the hub serves the reads
// the fast half itself performs.
describe("POST /complete — seeded-admin fallback", () => {
  test("connects onto the root bench when no principal matches the personal slug", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({
        data: [
          {
            principalId: "prn_root",
            tenantId: "ten_root",
            tenantName: "acme",
            tenantSlug: "acme",
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      }),
    );
    hub.get("/api/tenants/ten_root", (c) =>
      c.json({
        id: "ten_root",
        name: "acme",
        slug: "acme",
        domain: "acme.bench.local",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    hub.get("/api/tenants/ten_root/assets", (c) => c.json([]));
    hub.get("/api/tenants/ten_root/workflows/deployments", (c) => c.json([]));
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        testAndPersistCredentialFn: (args) =>
          testAndPersistCredential({
            ...args,
            ensureProviderFn: async (_api, _cookies, seedArgs) =>
              `prv_${seedArgs.name}`,
            ensureCredentialFn: async (_api, _cookies, persistArgs) =>
              `cred_${persistArgs.providerId}`,
            seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
          }),
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
      };
      expect(body.kind).toBe("provisioning");
      expect(body.tenantSlug).toBe("acme");
    } finally {
      server.stop(true);
    }
  });
});

// CL-7584: the doc-derived step list. `/provisioning-status` carries the
// doc-labeled steps a waiting surface renders; the converge itself moved
// to the client's needs-list (CL-8085), so no server-side kick remains
// to test here.
describe("CL-7584 desired-state steps", () => {
  function assetRow(name: string, kind: string) {
    return {
      id: `ast_${name}`,
      tenantId: "ten_root",
      kind,
      name,
      displayName: null,
      creatorPrincipalId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      origin: { tenantId: "ten_root", direct: true },
    };
  }

  function mountHub(state: { seeded: boolean }) {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({
        data: [
          {
            principalId: "prn_root",
            tenantId: "ten_root",
            tenantName: "workbench",
            tenantSlug: "workbench",
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      }),
    );
    hub.get("/api/tenants/ten_root", (c) =>
      c.json({
        id: "ten_root",
        name: "workbench",
        slug: "workbench",
        domain: "workbench.bench.local",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    hub.get("/api/tenants/ten_root/assets", (c) => {
      if (c.req.query("kind") === "workflow") {
        return c.json(state.seeded ? [assetRow("assistant", "workflow")] : []);
      }
      if (c.req.query("kind") === "package-registry") {
        return c.json(
          state.seeded ? [assetRow("corbits-tools", "package-registry")] : [],
        );
      }
      return c.json([]);
    });
    hub.get("/api/tenants/ten_root/workflows/deployments", (c) =>
      c.json(
        state.seeded
          ? [{ definitionAssetId: "ast_assistant", status: "deployed" }]
          : [],
      ),
    );
    hub.get("/api/tenants/ten_root/assets/ast_corbits-tools/tarballs", (c) =>
      c.json(
        state.seeded
          ? [
              {
                filename: "corbits-memory-tools-0.0.4.tgz",
                size: 1,
                integrity: "sha512-x",
              },
            ]
          : [],
      ),
    );
    hub.get("/api/tenants/ten_root/skills/:name", (c) =>
      state.seeded
        ? c.json({ name: c.req.param("name") })
        : c.json({ error: "none" }, 404),
    );
    return hub;
  }

  function mountRoutes(hub: Hono) {
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const routes = createOnboardingRoutes({
      hubUrl: `http://localhost:${server.port}`,
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
    });
    return { server, app: mountAuthenticated(routes) };
  }

  test("GET /provisioning-status carries the doc-derived step list", async () => {
    const hub = mountHub({ seeded: false });
    const { server, app } = mountRoutes(hub);
    try {
      const response = await app.request(
        "/provisioning-status?tenantId=ten_root",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        setupAgentReady: boolean;
        steps: { name: string; label: string; status: string }[];
      };
      expect(body.kind).toBe("provisioning");
      expect(body.setupAgentReady).toBe(false);
      expect(body.steps[0]?.name).toBe("assistant");
      expect(body.steps.every((s) => s.status === "pending")).toBe(true);
      expect(body.steps.every((s) => s.label.length > 0)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
