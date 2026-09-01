// Proves the eval-run read routes (CL-6465) exist inside the native
// tenant middleware — the same shape `presence-mount.test.ts` proves
// for presence. `@corbits/evals`' own request-parsing, grant-gating,
// and error-envelope behavior is covered by that package's own
// `routes.test.ts`; this only proves the composition-root wiring in
// `src/index.ts` actually reaches a live app instead of 404ing.

import { afterAll, expect, test } from "bun:test";
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

const root = mkdtempSync(path.join(tmpdir(), "hub-eval-runs-mount-"));
const staticDir = path.join(root, "static");
mkdirSync(staticDir, { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
mkdirSync(path.join(root, "data"), { recursive: true });

const config: HubConfig = {
  databaseUrl,
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: path.join(root, "data"),
  hubStaticDir: staticDir,
  defaultTenantSlug: "workbench",
  signupRateLimit: { windowSeconds: 60, max: 5 },
  signInRateLimit: { windowSeconds: 60, max: 10 },
  socialProviders: {},
  signupMode: "closed",
  allowedEmailDomains: [],
  allowPlaintextSecrets: true,
  allowUnverifiedEmails: true,
  sidecarProvisioners: [],
  envProviderKeys: {},
  envProviderBaseUrls: {},
  envCredentialPlantAdmin: {
    email: "alice@example.com",
    password: "password123",
    orgSlug: "workbench",
  },
  chatIdleReapMs: 30 * 60_000,
};

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describeIfDb("eval-runs mount", () => {
  test("eval-run routes mount inside the native tenant middleware", async () => {
    const hub = await createHub(config);
    closers.push(hub.close);

    const gated = await hub.app.request(
      "/api/tenants/some-tenant/eval-runs/runs",
    );
    // Unauthenticated, not unmounted: a 401 from the tenant auth
    // middleware proves the route exists (an unmounted route would
    // 404 before ever reaching a grant check).
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    const gatedDetail = await hub.app.request(
      "/api/tenants/some-tenant/eval-runs/runs/evalrun_1",
    );
    expect(gatedDetail.status).toBe(401);

    // The route exists only under the tenant scope; outside it the
    // path falls through to the interface shell.
    const outside = await hub.app.request("/eval-runs/runs");
    expect(await outside.text()).toBe("<html>shell</html>");
  });
});
