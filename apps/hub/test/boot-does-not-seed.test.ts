// Process-boot and createHub proof that hub production boot does not
// mint a root tenant or an admin account. An empty database is a valid
// hub: /status, health, and auth mechanics serve with zero tenant rows.
// First signup (signup-genesis.test.ts) is the 0→1 path.
//
// DB-gated: boots against its own scratch database so a reachable
// DATABASE_URL is required and the suite skips without one.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

import { setupDatabase } from "../../../scripts/db-setup.ts";
import { dbGate } from "../../../scripts/e2e/db-gate.ts";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url.ts";
import {
  api,
  createCleanupHarness,
  freePort,
  hop,
  startHub,
} from "../../../scripts/e2e/harness.ts";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const { tempDir, track } = createCleanupHarness();

const ALICE = { email: "alice@example.com", password: "password123" };

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  let closer: (() => Promise<void>) | undefined;
  while ((closer = closers.pop()) !== undefined) await closer();
});

function scratchUrl(suffix: string): string {
  const url = new URL(databaseUrl ?? "postgres://localhost:5432/unused");
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_${suffix}`;
  return url.toString();
}

async function withScratchDatabase(
  suffix: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const scratchUrlValue = scratchUrl(suffix);
  const maintenanceUrl = new URL(scratchUrlValue);
  maintenanceUrl.pathname = "/postgres";
  const scratchDatabase = new URL(scratchUrlValue).pathname.replace(/^\//, "");
  const maintenance = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
  } finally {
    await maintenance.end();
  }
  await setupDatabase(scratchUrlValue);
  try {
    await run(scratchUrlValue);
  } finally {
    const cleanup = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await cleanup.unsafe(
        `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`,
      );
    } finally {
      await cleanup.end();
    }
  }
}

async function countTenants(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from tenant
    `;
    const count = rows[0]?.count;
    if (typeof count !== "number") {
      throw new Error(
        `tenant count: expected a number, got ${JSON.stringify(rows)}`,
      );
    }
    return count;
  } finally {
    await sql.end();
  }
}

test("process boot source does not mention the deleted boot seeder", () => {
  const indexSource = readFileSync(
    path.join(import.meta.dir, "../src/index.ts"),
    "utf8",
  );
  expect(indexSource).not.toContain("runSystem" + "Seed");
  expect(indexSource).not.toContain("system" + "-seed");
  expect(indexSource).not.toContain("ensureDefault" + "Tenant");
  expect(indexSource).not.toContain("default" + "-tenant");
  expect(indexSource).not.toContain("skipEnsureDefault" + "Tenant");
});

describeIfDb("hub process boot does not mint a root tenant", () => {
  test("process boot serves /status with an empty tenant table and no boot admin", async () => {
    await withScratchDatabase("boot_does_not_seed", async (url) => {
      const dataDir = await tempDir("hub-boot-does-not-seed-");
      const hub = await hop("hub process boot", () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir,
        }),
      );
      track(hub);

      const status = await hop("/status", async () => {
        const res = await fetch(`${hub.baseUrl}/status`);
        expect(res.status).toBe(200);
        return res;
      });
      expect(await status.json()).toEqual({ status: "ok" });

      expect(await countTenants(url)).toBe(0);

      const signIn = await hop(
        "sign-in as the former boot admin is not 200",
        async () =>
          api(hub.baseUrl, "POST", "/api/auth/sign-in/email", {
            email: ALICE.email,
            password: ALICE.password,
          }),
      );
      expect(signIn.status).not.toBe(200);
    });
  }, 60_000);
});

describeIfDb("createHub on a scratch database inserts no tenant", () => {
  test("createHub serves health and auth with zero tenant rows", async () => {
    await withScratchDatabase("create_hub_empty", async (url) => {
      const root = mkdtempSync(path.join(tmpdir(), "hub-createhub-empty-"));
      const staticDir = path.join(root, "static");
      mkdirSync(staticDir, { recursive: true });
      writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
      mkdirSync(path.join(root, "data"), { recursive: true });

      const config: HubConfig = {
        databaseUrl: url,
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
        chatIdleReapMs: 30 * 60_000,
      };
      const hub = await createHub(config);
      const stop = async () => {
        await hub.close();
        rmSync(root, { recursive: true, force: true });
      };
      closers.push(stop);

      const status = await hub.app.request("/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ status: "ok" });

      const me = await hub.app.request("/api/me/principals");
      expect(me.status).toBe(401);

      expect(await countTenants(url)).toBe(0);
    });
  }, 60_000);
});

// CL-7579: hub boot must never plant provider credentials from
// environment variables. Operators connect providers through the
// onboarding/connect flow instead, so a hub booted with curated
// provider env vars set (e.g. OLLAMA_BASE_URL) inserts zero credential
// rows and zero catalog offerings — verified against a local fake
// Ollama whose probe the old env-plant would have passed.
describeIfDb("boot with provider env vars plants nothing (CL-7579)", () => {
  function fakeOllama(): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "qwen3.8:27b", model: "qwen3.8:27b" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  }

  async function countRows(url: string, table: string): Promise<number> {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const rows = await sql<{ count: number }[]>`
        select count(*)::int as count from ${sql(table)}
      `;
      return rows[0]?.count ?? 0;
    } finally {
      await sql.end();
    }
  }

  /** Fails fast once the old plant's rows appear; resolves quietly when
   * the plant never fires, giving its boot-time retry a real window. */
  async function expectZeroRowsFor(url: string, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const credentials = await countRows(url, "credential");
      const offerings = await countRows(url, "offering");
      if (credentials > 0 || offerings > 0) {
        throw new Error(
          `boot planted state: ${credentials} credential row(s), ${offerings} offering row(s)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function genesisOwner(
    baseUrl: string,
  ): Promise<void> {
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": `198.51.100.${Math.floor(Math.random() * 200) + 10}`,
      },
      body: JSON.stringify({
        name: "Alice",
        email: ALICE.email,
        password: ALICE.password,
      }),
    });
    expect(signUp.status).toBe(200);
    const cookies = signUp.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    const provision = await fetch(`${baseUrl}/api/onboarding/provision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies.join("; "),
      },
      body: JSON.stringify({ name: "Workbench" }),
    });
    expect(provision.status).toBe(200);
  }

  test("process boot with OLLAMA_BASE_URL set inserts no credential or offering rows", async () => {
    await withScratchDatabase("boot_env_key_no_plant", async (url) => {
      // Phase 1: mint the operator identity (signup genesis) so the old
      // plant's target — admin sign-in + root tenant by slug — resolves
      // immediately on the second boot. Without it the plant would sit
      // in its retry loop and the test would prove nothing.
      const genesis = await hop("hub process boot", async () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("hub-boot-env-plant-genesis-"),
        }),
      );
      await genesisOwner(genesis.baseUrl);
      await genesis.stop();

      // Phase 2: reboot with a provider env var set, aimed at a fake
      // Ollama whose probe would have succeeded.
      const ollama = fakeOllama();
      try {
        const hub = await hop(
          "hub process boot with OLLAMA_BASE_URL",
          async () =>
            startHub({
              databaseUrl: url,
              port: freePort(),
              sessionSecret: Buffer.from(
                crypto.getRandomValues(new Uint8Array(32)),
              ).toString("hex"),
              dataDir: await tempDir("hub-boot-env-plant-"),
              extraEnv: { OLLAMA_BASE_URL: ollama.url },
            }),
        );
        track(hub);
        await expectZeroRowsFor(url, 15_000);
      } finally {
        ollama.stop();
      }
    });
  }, 90_000);

  test("createHub with a resolved operator bench plants no credential rows", async () => {
    await withScratchDatabase("create_hub_env_key_no_plant", async (url) => {
      const root = mkdtempSync(path.join(tmpdir(), "hub-createhub-plant-"));
      const staticDir = path.join(root, "static");
      mkdirSync(staticDir, { recursive: true });
      writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
      mkdirSync(path.join(root, "data"), { recursive: true });

      // Onboarding routes reach the hub over HTTP, so the composed app
      // must be served on a real port and `baseUrl` must name it.
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("booting", { status: 503 }),
      });

      const baseConfig: HubConfig = {
        databaseUrl: url,
        baseUrl: `http://localhost:${server.port}`,
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
        chatIdleReapMs: 30 * 60_000,
      };

      // Phase 1: mint the operator bench the old plant targeted.
      const genesis = await createHub(baseConfig);
      server.reload({ fetch: genesis.app.fetch });
      const signUp = await genesis.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "198.51.100.77",
        },
        body: JSON.stringify({
          name: "Alice",
          email: ALICE.email,
          password: ALICE.password,
        }),
      });
      expect(signUp.status).toBe(200);
      const provision = await genesis.app.request("/api/onboarding/provision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: signUp.headers.getSetCookie().join("; "),
        },
        body: JSON.stringify({ name: "Workbench" }),
      });
      expect(provision.status).toBe(200);
      await genesis.close();

      const ollama = fakeOllama();
      try {
        const hub = await createHub({
          ...baseConfig,
          hubDataDir: path.join(root, "data-2"),
        });
        server.reload({ fetch: hub.app.fetch });
        closers.push(async () => {
          server.stop(true);
          await hub.close();
          rmSync(root, { recursive: true, force: true });
        });
        await expectZeroRowsFor(url, 15_000);
      } finally {
        ollama.stop();
      }
    });
  }, 90_000);
});
