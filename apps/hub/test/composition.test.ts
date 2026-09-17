// Exercises the hub's own wiring: platform routes answering at boot,
// an extension route mounted inside the native tenant middleware, and
// same-origin static serving. Platform behavior behind the mounted
// routes belongs to its own packages and is not re-proven here. Booting
// the hub runs package migrations, so a reachable DATABASE_URL is
// required and the suite skips without one.

import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";
import { dbGate } from "../../../scripts/e2e/db-gate";

// DB-gated: skipped when DATABASE_URL is unset, matching this repo's
// convention for tests that talk to a real Postgres.
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const root = mkdtempSync(path.join(tmpdir(), "hub-composition-"));
const staticDir = path.join(root, "static");
mkdirSync(path.join(staticDir, "assets"), { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
writeFileSync(path.join(staticDir, "assets", "app.css"), "body{}");
mkdirSync(path.join(root, "data"), { recursive: true });

const config: HubConfig = {
  databaseUrl,
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: path.join(root, "data"),
  hubStaticDir: staticDir,
  signupRateLimit: { windowSeconds: 60, max: 5 },
  socialProviders: {},
  // No CREDENTIAL_ENCRYPTION_KEY here: this suite never touches the
  // credential-cipher seam, so the dev opt-in keeps boot working.
  allowPlaintextSecrets: true,
  sidecarProvisioners: [],
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

describeIfDb("boot", () => {
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

describeIfDb("shutdown", () => {
  test("close() cancels the pending sidecar allocation reconciliation timer", async () => {
    const setTimeoutSpy = spyOn(global, "setTimeout");
    const clearTimeoutSpy = spyOn(global, "clearTimeout");

    const hub = await createHub(config);
    // index.ts schedules its reconciliation loop with setTimeout(fn,
    // 1000) — the one 1000ms setTimeout call site in the module — so
    // this is the pending timer close() must cancel.
    const reconciliationCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 1000);
    expect(reconciliationCallIndex).toBeGreaterThanOrEqual(0);
    const reconciliationTimerId = setTimeoutSpy.mock.results[reconciliationCallIndex]
      ?.value as ReturnType<typeof setTimeout>;

    await hub.close();

    expect(clearTimeoutSpy.mock.calls.map((call) => call[0])).toContain(reconciliationTimerId);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

describeIfDb("extension mounting", () => {
  test("chat mounts inside the native tenant middleware", async () => {
    const hub = await bootHub();

    // Anonymous request to an extension route: the platform's tenant
    // middleware answers 401 before the extension's handler runs.
    const gated = await hub.app.request("/api/tenants/some-tenant/chat/workbenches");
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    // The route exists only under the tenant scope; outside it the
    // path falls through to the interface shell.
    const outside = await hub.app.request("/chat/workbenches");
    expect(await outside.text()).toBe("<html>shell</html>");
  });
});

describeIfDb("stock signup carries no email-verification gate", () => {
  test("a fresh self-serve signup can create a tenant without verifying anything", async () => {
    const hub = await createHub(config);
    closers.push(hub.close);

    const email = `first-run-${crypto.randomUUID()}@example.com`;
    const signUp = await hub.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password123",
        name: "New User",
      }),
    });
    expect(signUp.status).toBe(200);

    const cookie = signUp.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const createTenant = await hub.app.request("/api/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
      },
      body: JSON.stringify({
        slug: `bench-${crypto.randomUUID().slice(0, 8)}`,
        name: "First Bench",
      }),
    });
    expect(createTenant.status).toBe(201);
  });
});
