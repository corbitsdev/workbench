// Proves the presence mount exists inside the native tenant middleware —
// the same shape `chat-mount.test.ts` proves for chat. Presence's own
// join/heartbeat/stream behavior belongs to `packages/presence`'s own
// tests; this only proves the composition-root wiring in `src/index.ts`
// actually reaches a live app.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "hub-presence-mount-"));
const staticDir = path.join(root, "static");
mkdirSync(staticDir, { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
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
  allowPlaintextSecrets: true,
  allowUnverifiedEmails: true,
  sidecarProvisioner: { kind: "none" },
};

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describe("presence mount", () => {
  test("presence routes mount inside the native tenant middleware", async () => {
    const hub = await createHub(config);
    closers.push(hub.close);

    const gated = await hub.app.request(
      "/api/tenants/some-tenant/presence/rooms/channel:chn_1/join",
      { method: "POST" },
    );
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    // The route exists only under the tenant scope; outside it the path
    // falls through to the interface shell.
    const outside = await hub.app.request("/presence/rooms/channel:chn_1/join");
    expect(await outside.text()).toBe("<html>shell</html>");
  });
});
