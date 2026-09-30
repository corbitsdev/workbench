// The one place an e2e suite boots a hub. It owns the whole lifecycle: a
// disposable data dir, the env the hub needs, shutdown, sidecar reaping, and
// data-dir removal. A leaked hub keeps reconciling the shared database and
// fails every other suite's allocations, so no test calls `createHubServer`
// directly.
import { afterAll, beforeAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDisposableHubDataDir } from "./disposable-hub-data-dir";

export type BootedHub = Awaited<
  ReturnType<typeof import("../../apps/hub/src/server").createHubServer>
>;

export type BootHubOptions = {
  /** Better Auth's trusted origin, read at boot; defaults to http://localhost. */
  baseUrl?: () => string;
  /** Port the in-process sidecar dials back, read at boot; unset for fetch-only hubs. */
  port?: () => number;
};

// The process provisioner deliberately lets sidecars outlive the hub (they
// are recovered from pid files on the next boot), so a test hub must reap
// its own or they redial a dead port forever.
function killSidecars(hubDataDir: string): void {
  const pidFiles: string[] = [];
  try {
    for (const dir of readdirSync(hubDataDir)) {
      if (!dir.startsWith("process-provisioner")) continue;
      const root = path.join(hubDataDir, dir, "allocations");
      for (const alloc of readdirSync(root)) {
        for (const unit of readdirSync(path.join(root, alloc))) {
          pidFiles.push(path.join(root, alloc, unit, "sidecar.pid"));
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of pidFiles) {
    let pid: number;
    try {
      pid = Number(readFileSync(file, "utf8").trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/**
 * Registers beforeAll/afterAll that boot and tear down one hub. Call it
 * synchronously inside the (gated) describe body: Bun runs an `afterAll`
 * registered from inside a hook or test immediately, so teardown can only be
 * registered while the file is being collected. Safe to call more than once
 * per file; each call owns its own hub and data dir.
 */
export function bootHub(opts: BootHubOptions = {}): () => BootedHub {
  let hub: BootedHub | undefined;
  let dataDir: ReturnType<typeof createDisposableHubDataDir> | undefined;

  beforeAll(async () => {
    dataDir = createDisposableHubDataDir();
    const url = new URL(process.env["DATABASE_URL"] ?? "");
    process.env["DB_HOST"] = url.hostname;
    process.env["DB_PORT"] = url.port === "" ? "5432" : url.port;
    process.env["DB_USER"] = decodeURIComponent(url.username);
    process.env["DB_PASSWORD"] = decodeURIComponent(url.password);
    process.env["DB_NAME"] = url.pathname.replace(/^\//, "");
    process.env["CREDENTIAL_ENCRYPTION_KEY"] ??= "0".repeat(64);
    process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"] ??= "1".repeat(64);
    process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] ??= "2".repeat(64);
    process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = "1";
    process.env["BASE_URL"] = opts.baseUrl?.() ?? "http://localhost";
    if (opts.port !== undefined) process.env["PORT"] = String(opts.port());

    const { createHubServer } = await import("../../apps/hub/src/server");
    hub = await createHubServer();
  }, 300_000);

  afterAll(async () => {
    await hub?.shutdown();
    if (dataDir !== undefined) killSidecars(dataDir.hubDataDir);
    dataDir?.restore();
  });

  return () => {
    if (hub === undefined) throw new Error("bootHub: hub not booted");
    return hub;
  };
}
