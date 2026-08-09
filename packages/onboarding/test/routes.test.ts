// The route's own error handling: a provisioning failure must never
// reach the caller as a bare, unhandled 500 — it should come back as
// the same `{ error: { code, message } }` envelope every other hub
// route uses, so the web layer can tell "nothing to do" apart from
// "this broke" instead of both looking like silence.

import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createOnboardingRoutes } from "../src/routes";

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
      pushWorkflow: async () => "pushed",
      log: (line) => lines.push(line),
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/provision", { method: "POST" });

    // An unrecognized failure (connection refused) is transient: the hub
    // may come back, and provisioning is idempotent so retry is safe.
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; kind: string; message: string };
    };
    expect(body.error.code).toBe("provisioning_failed");
    expect(body.error.kind).toBe("transient");
    expect(typeof body.error.message).toBe("string");
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
        pushWorkflow: async () => "pushed",
        log: () => undefined,
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
        pushWorkflow: async () => "pushed",
        log: () => undefined,
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
      pushWorkflow: async () => "pushed",
      log: () => undefined,
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
        pushWorkflow: async () => "pushed",
        log: () => undefined,
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

  test("an anonymous request is rejected before provisioning runs", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
      log: () => undefined,
    });

    const response = await routes.request("/provision", { method: "POST" });

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("unauthorized");
  });
});

describe("POST /credential/test", () => {
  test("an anonymous request is rejected before any credential is tested", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
      log: () => undefined,
    });

    const response = await routes.request("/credential/test", {
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

  test("a missing key is rejected with a specific message, no network call made", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
      log: () => undefined,
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
  });

  test("an unsupported provider is rejected with a specific message", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
      log: () => undefined,
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "cohere", apiKey: "key" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("POST /complete", () => {
  test("an anonymous request is rejected before anything is seeded", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
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
      pushWorkflow: async () => "pushed",
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
});
