// Local development bootstrap behind `bun run dev`: validates configuration,
// verifies the Postgres in DATABASE_URL is reachable, and starts the hub.
// The hub provisions sidecars on demand. Prerequisite failures name the
// actual problem and the fix.
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setupDatabase } from "./db-setup.ts";
import { localDevMemoryEmbedEnv } from "./setup-memory.ts";

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

/**
 * The slice of the hub's own env config this script needs to validate
 * before spawning anything. The hub itself (apps/hub/src/server.ts)
 * reads process.env directly now, upstream-style — this is just the
 * subset dev.ts needs for its own preflight checks.
 */
interface DevConfig {
  databaseUrl: string;
  baseUrl: string;
}

function validateConfig(): DevConfig {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    fail("DATABASE_URL is not set. Set it in .env; see .env.example.");
  }
  const port = process.env["PORT"] ?? "3000";
  const baseUrl = process.env["BASE_URL"] ?? `http://localhost:${port}`;
  for (const [name, hex] of [
    ["CREDENTIAL_ENCRYPTION_KEY", process.env["CREDENTIAL_ENCRYPTION_KEY"]],
    ["PRINCIPAL_KEY_ENCRYPTION_KEY", process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"]],
    ["SIDECAR_CREDENTIAL_ENCRYPTION_KEY", process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]],
  ] as const) {
    if (hex === undefined || hex.trim() === "") {
      fail(`${name} is not set. Set it in .env; see .env.example.`);
    }
  }
  // apps/hub/src/server.ts reads DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
  // individually (upstream's own shape), while every other script in this
  // repo (migrations, the memory/artifacts planes) uses the single
  // DATABASE_URL connection string. Derive the former from the latter here
  // so .env only needs to state one URL.
  const url = new URL(databaseUrl);
  mergeHubEnv({
    DB_HOST: url.hostname,
    DB_PORT: url.port === "" ? "5432" : url.port,
    DB_USER: decodeURIComponent(url.username || process.env["USER"] || "postgres"),
    DB_PASSWORD: decodeURIComponent(url.password),
    DB_NAME: url.pathname.replace(/^\//, ""),
  });
  return { databaseUrl, baseUrl };
}

// A DATABASE_URL without a username makes the postgres driver fall back to
// the USER environment variable; without that either, the connection dies
// deep inside the hub as a Postgres role error. Catch it before boot.
function requireDatabaseUser(config: DevConfig): void {
  if (new URL(config.databaseUrl).username !== "") return;
  if ((process.env["USER"] ?? "") !== "") return;
  fail(
    [
      "DATABASE_URL names no username and USER is not set in this",
      "environment, so Postgres has no role to connect as. Add a username",
      "to DATABASE_URL in .env, for example:",
      "",
      "  DATABASE_URL=postgres://<your-postgres-user>@localhost:5432/workbench",
    ].join("\n"),
  );
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
    socket.once("timeout", () => settle(connected ? "not-postgres" : "unreachable"));
  });
}

async function requireDatabaseReachable(config: DevConfig): Promise<void> {
  const url = new URL(config.databaseUrl);
  const host = url.hostname;
  const port = Number(url.port === "" ? "5432" : url.port);
  // "localhost" resolves to both 127.0.0.1 and ::1, and a listener can bind
  // one family while an unrelated process holds the other — so every
  // reachable listener must answer as Postgres, not just one of them.
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  const results = await Promise.all(addresses.map((address) => probePostgres(address, port)));
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
  /** Command to run in `dir`; defaults to the app's own dev script. */
  command?: string[];
}

// Each command IS the final long-running process — never a `bun run`
// script wrapper. Killing a wrapper leaves its grandchild running, which
// is exactly how orphaned hubs end up squatting the port after Ctrl-C.
const hubApp: App = {
  label: "hub",
  dir: join(repoRoot, "apps", "hub"),
  command: ["bun", "--watch", "--env-file=../../.env", "src/index.ts"],
};
// Local bootstrap needs no signup env: stock Interchange composition
// leaves self-serve signup ungated (rate-limited only), so seedDevAccount
// below can always register alice on a fresh checkout.
function mergeHubEnv(extra: Record<string, string>): void {
  hubApp.env = { ...hubApp.env, ...extra };
}
const localMemoryEmbed = localDevMemoryEmbedEnv(process.env, {
  hasNativeOllama: Bun.which("ollama") !== null,
});
if (localMemoryEmbed !== undefined) {
  mergeHubEnv(localMemoryEmbed);
}

// The hub is a plain API now (CL-8083): it serves no static build, so
// the web app runs its own dev server, proxying /api to the hub per
// apps/web/vite.config.ts.
const webDir = join(repoRoot, "apps", "web");
const webApp: App = {
  label: "web",
  dir: webDir,
  command: [join(webDir, "node_modules", ".bin", "vite")],
};

const apps: App[] = [hubApp, webApp];

function requireApps(): void {
  const missing = [...apps, { dir: join(repoRoot, "apps", "sidecar") }].filter(
    (app) => !existsSync(join(app.dir, "package.json")),
  );
  if (missing.length === 0) return;
  fail(
    [
      "This checkout is missing runnable app(s):",
      ...missing.map((app) => `  - ${app.dir}`),
      "The hub provisions sidecars from this checkout; it cannot",
      "run until the required apps exist. Use an up-to-date checkout.",
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

interface RunningApp {
  app: App;
  proc: Bun.Subprocess;
}

// Apps can start at different times now (web may be deferred), so exits
// are watched per-process as they're spawned rather than raced over a
// fixed list gathered up front.
function spawnApp(app: App, running: RunningApp[], onExit: (app: App, code: number) => void): void {
  const proc = Bun.spawn(app.command ?? ["bun", "run", "dev"], {
    cwd: app.dir,
    env: { ...process.env, ...app.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  void forwardWithPrefix(app.label, proc.stdout, (line) => console.log(line));
  void forwardWithPrefix(app.label, proc.stderr, (line) => console.error(line));
  running.push({ app, proc });
  void proc.exited.then((code) => onExit(app, code));
}

async function startApps(): Promise<never> {
  const running: RunningApp[] = [];
  const stopAll = () => {
    for (const { proc } of running) proc.kill();
  };
  process.on("SIGINT", () => {
    stopAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(143);
  });

  const firstExit = await new Promise<{ app: App; code: number }>((resolveExit) => {
    const onExit = (app: App, code: number) => resolveExit({ app, code });
    for (const app of apps) spawnApp(app, running, onExit);
  });
  stopAll();
  fail(`${firstExit.app.label} exited with code ${firstExit.code}; stopping the other apps.`);
}

// Bring the database's schema current before the apps boot: creates
// the database and applies the platform migrations when needed, and
// reports either way. Failures name the problem and the fix.
async function requireDatabaseSetUp(config: DevConfig): Promise<void> {
  try {
    const report = await setupDatabase(config.databaseUrl);
    if (report.createdDatabase) {
      console.log(`[dev] created database ${JSON.stringify(report.database)}`);
    }
    console.log(`[dev] database ${JSON.stringify(report.database)} schema is current`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Create the administrator account once the hub answers, so a fresh
 * checkout can sign in immediately. Runs beside the apps; unset
 * identity variables fall back to the same defaults the CLI uses, so a
 * zero-edit .env still yields a signable account: stock composition
 * leaves self-serve signup ungated, so fresh registration always works.
 * "Already exists" is a skip, not an error — re-runs stay quiet.
 *
 * Sign-in is tried first so a re-run against an existing account skips
 * registration entirely.
 */
async function seedDevAccount(config: DevConfig): Promise<void> {
  const email = process.env["HUB_ADMIN_EMAIL"] ?? "alice@example.com";
  const password = process.env["HUB_ADMIN_PASSWORD"] ?? "password123";
  const name = email.split("@")[0] ?? email;
  const readinessTimeoutMs = 30_000;
  const deadline = Date.now() + readinessTimeoutMs;
  let hubReady = false;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${config.baseUrl}/api/auth/get-session`);
      if (probe.ok) {
        hubReady = true;
        break;
      }
    } catch {
      // hub not listening yet; keep waiting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // A timed-out wait must never fall through into the sign-in/sign-up
  // attempt below: that attempt would only reproduce the same "unable to
  // connect" failure this wait exists to rule out, and swallowing it (the
  // former behavior) left alice's account permanently half-provisioned —
  // created, but with none of its default agents ever deployed, and no
  // sign a person could see. Fail the whole dev bootstrap loudly instead.
  if (!hubReady) {
    fail(
      [
        `[dev] the hub at ${config.baseUrl} never answered ` +
          `/api/auth/get-session within ${readinessTimeoutMs / 1000}s, so`,
        `account seeding for ${email} did not run. Check the hub's own`,
        "log output above for why it never came up, fix that, then re-run",
        "`bun run dev`.",
      ].join(" "),
    );
  }
  try {
    const signIn = await fetch(`${config.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (signIn.ok) {
      console.log(`[dev] account ${email} already exists`);
      return;
    }

    const signUp = await fetch(`${config.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    if (signUp.ok) {
      console.log(`[dev] seeded account ${email} (password from .env)`);
      return;
    }

    const body = await signUp.text();
    if (/exist/i.test(body)) {
      console.log(`[dev] account ${email} already exists`);
      return;
    }
    fail(`[dev] could not seed account ${email}: ${signUp.status} ${body}`);
  } catch (error) {
    fail(
      `[dev] could not seed account ${email}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// A second stack half-dying against a squatter on the hub port is the
// worst failure shape this script can produce: the old hub keeps serving
// stale state, the new sidecar attaches to it, agents fail their
// challenges, and every symptom points somewhere else. Refuse loudly
// up front instead.
async function requireHubPortFree(config: DevConfig): Promise<void> {
  const base = new URL(config.baseUrl);
  const port = Number(base.port === "" ? (base.protocol === "https:" ? "443" : "80") : base.port);
  const occupied = await new Promise<boolean>((resolvePort) => {
    const socket = createConnection({
      host: base.hostname,
      port,
      timeout: 1500,
    });
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once("error", () => resolvePort(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolvePort(false);
    });
  });
  if (occupied) {
    fail(
      [
        `Something is already listening on port ${port} (from BASE_URL).`,
        "Most likely another `bun run dev` is still running — starting a",
        "second stack against it produces broken, confusing behavior, so",
        "this one is refusing to start. Stop the other stack first:",
        `  lsof -ti :${port} | xargs kill`,
        "or change BASE_URL in .env to a free port.",
      ].join("\n"),
    );
  }
}

if (import.meta.main) {
  requireEnvFile();
  const config = validateConfig();
  requireDatabaseUser(config);
  await requireHubPortFree(config);
  await requireDatabaseReachable(config);
  await requireDatabaseSetUp(config);
  requireApps();
  void seedDevAccount(config);
  await startApps();
}
