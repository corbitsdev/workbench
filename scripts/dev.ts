// Local development bootstrap behind `bun run dev`: validates configuration,
// verifies the Postgres in DATABASE_URL is reachable, and starts the hub and
// sidecar together. Every prerequisite failure exits with a message naming
// the actual problem and the fix.
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { readHubConfig, type HubConfig } from "../apps/hub/src/config.ts";
import { ensureSidecarIdentity, setupDatabase } from "./db-setup.ts";

const repoRoot = resolve(import.meta.dir, "..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireEnvFile(): void {
  if (existsSync(join(repoRoot, ".env"))) return;
  fail(
    [
      `No .env file found in ${repoRoot}.`,
      "Create one from the template and re-run:",
      "",
      "  cp .env.example .env",
      "  bun run dev",
    ].join("\n"),
  );
}

function validateConfig(): HubConfig {
  try {
    return readHubConfig(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

type ProbeResult = "postgres" | "unreachable" | "not-postgres";

// Speaks just enough of the Postgres wire protocol (an SSLRequest, answered
// with 'S' or 'N') to distinguish a real Postgres from an unrelated process
// squatting on the port — a bare TCP connect cannot tell them apart.
function probePostgres(host: string, port: number): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port, timeout: 2000 });
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
      socket.write(sslRequest);
      socket.once("data", (data) => {
        const reply = data[0];
        settle(reply === 83 || reply === 78 ? "postgres" : "not-postgres");
      });
    });
    socket.once("error", () => settle("unreachable"));
    socket.once("timeout", () =>
      settle(connected ? "not-postgres" : "unreachable"),
    );
  });
}

async function requireDatabaseReachable(config: HubConfig): Promise<void> {
  const url = new URL(config.databaseUrl);
  const host = url.hostname;
  const port = Number(url.port === "" ? "5432" : url.port);
  // "localhost" resolves to both 127.0.0.1 and ::1, and a listener can bind
  // one family while an unrelated process holds the other — so every
  // reachable listener must answer as Postgres, not just one of them.
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  const results = await Promise.all(
    addresses.map((address) => probePostgres(address, port)),
  );
  const occupied = results.includes("not-postgres");
  const reachable = results.includes("postgres");
  if (reachable && !occupied) return;
  if (!occupied) {
    fail(
      [
        `The database at ${host}:${port} (from DATABASE_URL) is not accepting`,
        "connections. Start a local Postgres and re-run. On macOS:",
        "",
        "  brew install postgresql@17 pgvector",
        "  brew services start postgresql@17",
        "",
        "If your Postgres runs elsewhere, point DATABASE_URL in .env at it.",
      ].join("\n"),
    );
  }
  fail(
    [
      `Something is listening at ${host}:${port} (from DATABASE_URL) but it`,
      "does not answer the Postgres protocol — another process is occupying",
      "the database port. Stop that process, or change DATABASE_URL in .env",
      "to point at your Postgres.",
    ].join("\n"),
  );
}

interface App {
  label: string;
  dir: string;
  env?: Record<string, string>;
}

const DEV_SIDECAR_ID = "sidecar-dev";

/**
 * The local sidecar's dial-in token, derived from SESSION_SECRET so it
 * is stable per checkout without another secret to manage. The database
 * stores only its hash; `ensureSidecarIdentity` refreshes the hash on
 * every dev start, so a changed SESSION_SECRET heals automatically.
 */
async function devSidecarToken(config: HubConfig): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${DEV_SIDECAR_ID}:${config.sessionSecret}`),
  );
  return Buffer.from(digest).toString("hex");
}

function sidecarEnv(config: HubConfig, token: string): Record<string, string> {
  const base = new URL(config.baseUrl);
  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  return {
    SIDECAR_DATA_DIR: join(repoRoot, ".data", "sidecar"),
    HUB_WS_URL: `${wsProtocol}//${base.host}/api/sidecars/ws`,
    SIDECAR_ID: DEV_SIDECAR_ID,
    SIDECAR_TOKEN: token,
  };
}

const apps: App[] = [
  { label: "hub", dir: join(repoRoot, "apps", "hub") },
  { label: "sidecar", dir: join(repoRoot, "apps", "sidecar") },
];

function requireApps(): void {
  const missing = apps.filter(
    (app) => !existsSync(join(app.dir, "package.json")),
  );
  if (missing.length === 0) return;
  fail(
    [
      "This checkout is missing runnable app(s):",
      ...missing.map((app) => `  - ${app.dir}`),
      "The dev bootstrap starts the hub and the sidecar together; it cannot",
      "run until both exist. Make sure you are on an up-to-date checkout.",
    ].join("\n"),
  );
}

async function forwardWithPrefix(
  label: string,
  stream: ReadableStream<Uint8Array>,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) write(`[${label}] ${line}`);
  }
  if (buffered !== "") write(`[${label}] ${buffered}`);
}

async function startApps(): Promise<never> {
  const processes = apps.map((app) => {
    const proc = Bun.spawn(["bun", "run", "dev"], {
      cwd: app.dir,
      env: { ...process.env, ...app.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    void forwardWithPrefix(app.label, proc.stdout, (line) => console.log(line));
    void forwardWithPrefix(app.label, proc.stderr, (line) =>
      console.error(line),
    );
    return { app, proc };
  });

  const stopAll = () => {
    for (const { proc } of processes) proc.kill();
  };
  process.on("SIGINT", () => {
    stopAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(143);
  });

  const firstExit = await Promise.race(
    processes.map(async ({ app, proc }) => ({ app, code: await proc.exited })),
  );
  stopAll();
  fail(
    `${firstExit.app.label} exited with code ${firstExit.code}; stopping the other app.`,
  );
}

// Bring the database's schema current before the apps boot: creates
// the database and applies the platform migrations when needed, and
// reports either way. Failures name the problem and the fix.
async function requireDatabaseSetUp(config: HubConfig): Promise<void> {
  try {
    const report = await setupDatabase(config.databaseUrl);
    if (report.createdDatabase) {
      console.log(`[dev] created database ${JSON.stringify(report.database)}`);
    }
    if (report.action === "migrated") {
      console.log(
        `[dev] applied ${report.migrations} platform migrations to database ` +
          `${JSON.stringify(report.database)}`,
      );
    } else {
      console.log(
        `[dev] database ${JSON.stringify(report.database)} schema is current`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Create the development convenience account once the hub answers, so a
 * fresh checkout can sign in immediately. Runs beside the apps; skipped
 * when either DEV_SEED_EMAIL or DEV_SEED_PASSWORD is empty or absent.
 * "Already exists" is a skip, not an error — re-runs stay quiet.
 */
async function seedDevAccount(config: HubConfig): Promise<void> {
  const email = process.env["DEV_SEED_EMAIL"] ?? "";
  const password = process.env["DEV_SEED_PASSWORD"] ?? "";
  if (email === "" || password === "") return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${config.baseUrl}/api/auth/get-session`);
      if (probe.ok) break;
    } catch {
      // hub not listening yet; keep waiting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const response = await fetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        name: email.split("@")[0] ?? email,
      }),
    });
    if (response.ok) {
      console.log(`[dev] seeded account ${email} (password from .env)`);
    } else {
      const body = await response.text();
      if (/exist/i.test(body)) {
        console.log(`[dev] account ${email} already exists`);
      } else {
        console.error(
          `[dev] could not seed account ${email}: ${response.status} ${body}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[dev] could not seed account ${email}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

requireEnvFile();
const config = validateConfig();
await requireDatabaseReachable(config);
await requireDatabaseSetUp(config);
const token = await devSidecarToken(config);
await ensureSidecarIdentity(config.databaseUrl, DEV_SIDECAR_ID, token);
console.log(`[dev] sidecar identity ${JSON.stringify(DEV_SIDECAR_ID)} ready`);
const sidecar = apps.find((app) => app.label === "sidecar");
if (sidecar) sidecar.env = sidecarEnv(config, token);
requireApps();
void seedDevAccount(config);
await startApps();
