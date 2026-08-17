// Proves the chat mount exists: an unauthenticated request to a chat
// route under the tenant prefix answers with the platform's own
// auth-error envelope, not a 404 (no route) or a crash (bad deps
// literal). Mirrors `composition.test.ts`'s echo-mount proof; chat's
// own request/response behavior belongs to `packages/chat`'s tests.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "hub-chat-mount-"));
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
  // No CREDENTIAL_ENCRYPTION_KEY here: this suite never touches the
  // credential-cipher seam, so the dev opt-in keeps boot working.
  allowPlaintextSecrets: true,
  allowUnverifiedEmails: true,
  sidecarProvisioner: { kind: "none" },
  envProviderKeys: {},
  envProviderBaseUrls: {},
  envCredentialPlantAdmin: {
    email: "alice@example.com",
    password: "password123",
    orgSlug: "workbench",
  },
};

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describe("chat mount", () => {
  test("chat routes mount inside the native tenant middleware", async () => {
    const hub = await createHub(config);
    closers.push(hub.close);

    const gated = await hub.app.request(
      "/api/tenants/some-tenant/chat/channels",
      {
        method: "GET",
      },
    );
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });

    // The route exists only under the tenant scope; outside it the
    // path falls through to the interface shell.
    const outside = await hub.app.request("/chat/channels");
    expect(await outside.text()).toBe("<html>shell</html>");
  });
});
