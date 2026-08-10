// Exercises the hub's own wiring: platform routes answering at boot,
// the echo extension mounted inside the native tenant middleware, and
// same-origin static serving. Platform behavior behind the mounted
// routes belongs to its own packages and is not re-proven here. No test
// needs a database: every asserted path fails or answers before a query
// would run.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "hub-composition-"));
const staticDir = path.join(root, "static");
mkdirSync(path.join(staticDir, "assets"), { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
writeFileSync(path.join(staticDir, "assets", "app.css"), "body{}");
mkdirSync(path.join(root, "data"), { recursive: true });

const config: HubConfig = {
  databaseUrl: "postgres://workbench:workbench@localhost:5432/workbench",
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: path.join(root, "data"),
  hubStaticDir: staticDir,
  signupRateLimit: { windowSeconds: 60, max: 5 },
  socialProviders: {},
  signupMode: "closed",
  allowedEmailDomains: [],
};

const closers: (() => Promise<void>)[] = [];

async function bootHub(): Promise<Awaited<ReturnType<typeof createHub>>> {
  const hub = await createHub(config);
  closers.push(hub.close);
  return hub;
}

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describe("boot", () => {
  test("serves platform health, auth-gated routes, and the interface", async () => {
    const hub = await bootHub();

    const status = await hub.app.request("/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "ok" });

    // The login gate is live: user-scoped platform routes answer 401
    // for an anonymous request instead of 404 or a crash.
    const me = await hub.app.request("/api/me/principals");
    expect(me.status).toBe(401);

    // The interface serves from the same origin: real files as-is,
    // unknown client-side routes as index.html.
    const asset = await hub.app.request("/assets/app.css");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("body{}");
    const deepLink = await hub.app.request("/settings/profile");
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toBe("<html>shell</html>");

    // Static serving never swallows the API prefix.
    const unknownApi = await hub.app.request("/api/no-such-route");
    expect(unknownApi.status).toBe(404);
  });
});

describe("extension mounting", () => {
  test("echo mounts inside the native tenant middleware", async () => {
    const hub = await bootHub();

    // Anonymous request to the echo route: the platform's tenant
    // middleware answers 401 before the extension's handler runs.
    const gated = await hub.app.request("/api/tenants/some-tenant/echo", {
      method: "POST",
      body: "hello",
    });
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    // The route exists only under the tenant scope; outside it the
    // path falls through to the interface shell.
    const outside = await hub.app.request("/echo");
    expect(await outside.text()).toBe("<html>shell</html>");
  });

  test("the first-login onboarding hook is gated the same way", async () => {
    const hub = await bootHub();

    const gated = await hub.app.request("/api/onboarding/provision", {
      method: "POST",
    });
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });
});
