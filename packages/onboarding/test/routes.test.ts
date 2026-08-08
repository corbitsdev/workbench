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
  test("an unreachable hub surfaces a structured error envelope, not a bare 500 body", async () => {
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

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("provisioning_failed");
    expect(typeof body.error.message).toBe("string");
    expect(lines.some((line) => line.includes("user_1"))).toBe(true);
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

describe("POST /credential", () => {
  test("an anonymous request is rejected before any credential is tested", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => "pushed",
      log: () => undefined,
    });

    const response = await routes.request("/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-whatever" }),
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

    const response = await app.request("/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
  });
});
