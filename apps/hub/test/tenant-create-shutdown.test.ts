// The tenant-create observer's shutdown contract: `stop()` refuses new
// kicks, `whenIdle()` waits out the in-flight ones, and the hub `close()`
// 250ms race bounds that wait so a stuck reconcile can never stall
// teardown. The observer half is DB-free (the reconcile step is injected);
// the `close()` half boots a real hub and so is DB-gated like every other
// suite that does.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { Hono } from "hono";
import type { ApiCall } from "@corbits/hub-api-client";
import type { WorkflowPusher } from "@corbits/connections/workflow-push";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";
import {
  createTenantCreateObserver,
  type TenantCreateOnboardDeps,
} from "../src/tenant-create-onboard.ts";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url";
import { setupDatabase } from "../../../scripts/db-setup";
import { dbGate } from "../../../scripts/e2e/db-gate";

const unreachableApi = (async () => {
  throw new Error("observer tests inject reconcileFn; the api is never called");
}) as unknown as ApiCall;
const unreachablePusher = (async () => {
  throw new Error(
    "observer tests inject reconcileFn; the pusher is never called",
  );
}) as unknown as WorkflowPusher;

function mountObserver(
  reconcileFn: NonNullable<TenantCreateOnboardDeps["reconcileFn"]>,
  logError: (line: string) => void = () => undefined,
) {
  const wrapped = new Hono();
  wrapped.get("/ping", (c) => c.text("pong"));
  return createTenantCreateObserver(
    {
      api: unreachableApi,
      hubUrl: "http://localhost:1",
      pushWorkflow: unreachablePusher,
      log: () => undefined,
      logError,
      reconcileFn,
    },
    // The wrapped app's type carries the hub's AppEnv; the observer only
    // forwards through it, so a bare Hono app suffices for these tests.
    wrapped as never,
  );
}

describe("tenant-create observer shutdown", () => {
  test("stop() refuses new kicks while whenIdle() waits out the in-flight one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const observer = mountObserver(async ({ tenantId }) => {
      runs += 1;
      await gate;
      return { tenantId, ready: true, pins: [] };
    });

    const first = observer.kick({ tenantId: "ten_a", cookies: [] });
    // Let the kick reach the stuck reconcile before stopping.
    await Bun.sleep(20);
    observer.stop();
    // A kick after stop resolves without running anything.
    await observer.kick({ tenantId: "ten_b", cookies: [] });
    expect(runs).toBe(1);

    // whenIdle is still waiting on the stuck kick, not resolved early.
    let idle = false;
    const idleWait = observer.whenIdle().then(() => {
      idle = true;
    });
    await Bun.sleep(20);
    expect(idle).toBe(false);

    release();
    await first;
    await idleWait;
    expect(idle).toBe(true);
  });

  test("a failed kick settles (never rejects) so whenIdle always resolves", async () => {
    const lines: string[] = [];
    const observer = mountObserver(
      async () => {
        throw new Error("sidecar exploded mid-reconcile");
      },
      (line) => lines.push(line),
    );
    await observer.kick({ tenantId: "ten_a", cookies: [] });
    await observer.whenIdle();
    expect(lines.some((line) => line.includes("ten_a"))).toBe(true);
  });
});

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("hub close() bound (CL-7584)", () => {
  test("close() on an idle hub resolves well inside the teardown budget", async () => {
    const scratchUrl = new URL(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );
    const dbName = scratchUrl.pathname.replace(/^\//, "");
    scratchUrl.pathname = `/${dbName}_shutdown`;
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    const scratchName = new URL(scratchUrl).pathname.replace(/^\//, "");
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchName}"`);
    } finally {
      await maintenance.end();
    }
    await setupDatabase(scratchUrl.toString());

    const root = mkdtempSync(path.join(tmpdir(), "hub-shutdown-"));
    const staticDir = path.join(root, "static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
    mkdirSync(path.join(root, "data"), { recursive: true });
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("booting", { status: 503 }),
    });
    const baseUrl = `http://localhost:${server.port}`;
    const config: HubConfig = {
      databaseUrl: scratchUrl.toString(),
      baseUrl,
      sessionSecret: "insecure-test-only-session-secret-0000",
      hubDataDir: path.join(root, "data"),
      hubStaticDir: staticDir,
      defaultTenantSlug: "workbench",
      signupRateLimit: { windowSeconds: 60, max: 5 },
      signInRateLimit: { windowSeconds: 60, max: 10 },
      socialProviders: {},
      signupMode: "open",
      allowedEmailDomains: [],
      allowPlaintextSecrets: true,
      allowUnverifiedEmails: true,
      sidecarProvisioners: [],
      chatIdleReapMs: 30 * 60_000,
    };
    const hub = await createHub(config);
    server.reload({ fetch: hub.app.fetch });
    try {
      const start = Date.now();
      await hub.close();
      const elapsed = Date.now() - start;
      // Measured, not guessed: idle close took ~0.8s locally
      // (2026-09-14, scratch Postgres on loopback); the assertion budget
      // is 10s (generous: CI teardown of server + pool). The 250ms
      // observer race inside close() bounds
      // the kick wait by construction, so a stuck kick cannot stall
      // teardown — but a stuck-kick-under-load timing proof is still
      // open: production wiring has no injection point for a hung
      // reconcile, so this covers the idle path only.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
      const cleanup = postgres(maintenanceUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await cleanup.unsafe(
          `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`,
        );
      } finally {
        await cleanup.end();
      }
    }
  }, 60_000);
});
