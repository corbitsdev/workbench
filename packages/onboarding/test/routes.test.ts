// The route's own error handling: a provisioning failure must never
// reach the caller as a bare, unhandled 500 — it should come back as
// the same `{ error: { code, userMessage, refId } }` envelope every other hub
// route uses, so the web layer can tell "nothing to do" apart from
// "this broke" instead of both looking like silence.

import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createNoopCredentialCipher } from "@intx/crypto";
import { createOnboardingRoutes } from "../src/routes";
import { createInMemoryPendingSeedStore } from "../src/pending-seed";
import { createProviderHealthStore } from "@corbits/connections/provider-health";
import { HubApiError } from "@corbits/hub-api-client";

// These tests never exercise the pending-seed store — it is required
// wiring for `createOnboardingRoutes`, and its dedicated coverage lives
// in `./complete-setup-routes.test.ts`, `./connect-deploys-nothing.test.ts`
// and `../src/pending-seed.test.ts`.
const pendingSeedStore = createInMemoryPendingSeedStore(
  createNoopCredentialCipher(),
);

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

describe("POST /provision", () => {
  test("an unreachable hub surfaces a transient error envelope (503), not a bare 500 body", async () => {
    const lines: string[] = [];
    const routes = createOnboardingRoutes({
      // Port 0 on loopback refuses every connection immediately, so the
      // underlying fetch throws deterministically without a live hub.
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: (line) => lines.push(line),
      pendingSeedStore,
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/provision", { method: "POST" });

    // An unrecognized failure (connection refused) is transient: the hub
    // may come back, and provisioning is idempotent so retry is safe.
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; kind: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("provisioning_failed");
    expect(body.error.kind).toBe("transient");
    expect(typeof body.error.userMessage).toBe("string");
    expect(typeof body.error.refId).toBe("string");
    // The raw detail (here, the connection-refused failure) is logged
    // behind the refId — never handed to the client as `userMessage`.
    expect(body.error.userMessage).not.toContain("ECONNREFUSED");
    expect(lines.some((line) => line.includes("user_1"))).toBe(true);
  });

  test("a permanent provision failure (slug conflict, no principal) maps to 500 with kind permanent", async () => {
    // A slug-conflict where the caller still has no principal anywhere is a
    // dead end the client cannot retry out of — it must surface as a
    // permanent error so the UI offers "contact support", not "try again".
    // Body must include a name so provision enters the create path; without
    // a name the route returns needs-onboarding and never hits the hub.
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    hub.post("/api/tenants", (c) =>
      c.json({ error: { code: "conflict", message: "Slug taken" } }, 409),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice's Lab" }),
      });

      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error: { code: string; kind: string; message: string };
      };
      expect(body.error.code).toBe("slug_conflict_no_principal");
      expect(body.error.kind).toBe("permanent");
    } finally {
      server.stop(true);
    }
  });

  test("a nameless membership probe returns needs-onboarding without creating", async () => {
    const creates: unknown[] = [];
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    hub.post("/api/tenants", async (c) => {
      creates.push(await c.req.json());
      return c.json({ id: "tnt_x" }, 201);
    });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/provision", { method: "POST" });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("needs-onboarding");
      expect(creates).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("rapid named create retries from the same user are rate-limited (429)", async () => {
    // Rate limit applies only to named creates (the membership probe must not
    // burn a slot — otherwise the naming wizard always 429s within 10s of
    // first login).
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      pendingSeedStore,
    });
    const app = mountAuthenticated(routes);
    const named = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice's Lab" }),
    };

    const first = await app.request("/provision", named);
    const second = await app.request("/provision", named);

    // The first call runs (and fails transiently against the dead hub).
    expect(first.status).toBe(503);
    // The second is short-circuited before provisioning runs.
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      error: { code: string; kind: string; message: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.kind).toBe("transient");
  });

  test("a membership probe does not rate-limit the following named create", async () => {
    // Two-step first-login: shell probe (no name) then naming submit (with name).
    // The probe must not consume the create rate-limit slot.
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const probe = await app.request("/provision", { method: "POST" });
      expect(probe.status).toBe(200);
      expect(((await probe.json()) as { kind: string }).kind).toBe(
        "needs-onboarding",
      );

      // Named create reaches the hub (503/500 from incomplete mock is fine);
      // the only failure mode this test forbids is 429 from the probe.
      const create = await app.request("/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice's Lab" }),
      });
      expect(create.status).not.toBe(429);
      expect([500, 503]).toContain(create.status);
    } finally {
      server.stop(true);
    }
  });

  test("malformed JSON on /provision is 400, not a silent membership probe", async () => {
    const creates: unknown[] = [];
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    hub.post("/api/tenants", async (c) => {
      creates.push(await c.req.json());
      return c.json({ id: "tnt_x" }, 201);
    });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("bad_request");
      expect(creates).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("schema-invalid provision body is 400, not a silent membership probe", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 12 }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("bad_request");
    } finally {
      server.stop(true);
    }
  });

  test("an anonymous request is rejected before provisioning runs", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      pendingSeedStore,
    });

    const response = await routes.request("/provision", { method: "POST" });

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("unauthorized");
  });
});

describe("POST /complete", () => {
  test("an anonymous request is rejected before anything is seeded", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      pendingSeedStore,
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
      pendingSeedStore,
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
        pendingSeedStore,
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
      pendingSeedStore,
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

  // CL-6457 moved partial-deploy convergence off this route entirely:
  // `/complete` no longer deploys anything, so there is no half-finished
  // deploy for it to report. What the route still owes the drain — a
  // durable pending row carrying the key the deploy runs against — is
  // covered by `./connect-deploys-nothing.test.ts` ("hands the drain a
  // pending row carrying the key it will deploy against"), and the
  // convergence that row buys is covered by `./bench-provisioning.test.ts`
  // ("a half-provisioned bench keeps its row and converges on a later pass").

  test("a non-sidecar failure during setup still fails loudly with the existing 500 envelope", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      pendingSeedStore,
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
      pendingSeedStore,
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
