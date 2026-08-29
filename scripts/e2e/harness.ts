// Harness for the end-to-end walking skeleton. Everything here exists
// to run the real stack — the hub and sidecar as spawned processes
// against a real Postgres — and to make a failing hop name itself.
// Nothing platform-side is mocked; when a hop cannot be exercised for
// real the suite fails and says which hop, it never fakes the result.

import { afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitWorkflowPusher } from "../../packages/hub-client/src/index.ts";
import { WORKFLOW_SOURCE_ENTRY } from "../../packages/workflow-source/src/index.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const HUB_DIR = path.join(REPO_ROOT, "apps", "hub");
const SIDECAR_DIR = path.join(REPO_ROOT, "apps", "sidecar");

// --- environment gate -------------------------------------------------

/**
 * The suite needs a real Postgres, named by DATABASE_URL. Locally a
 * missing DATABASE_URL skips the suite (a fresh checkout without a
 * database still runs the unit gates); in CI, E2E_REQUIRED=1 turns
 * that skip into a loud failure so the suite can never silently
 * vanish from the pipeline.
 *
 * `bun test` workers do not always inherit process.env.DATABASE_URL
 * even when the shell sourced `.env`. Fall back to the same repo-root
 * `.env` file `bun run` would load.
 */
export function e2eDatabaseUrl(): string | undefined {
  const fromProcess = process.env["DATABASE_URL"];
  const url =
    fromProcess !== undefined && fromProcess !== ""
      ? fromProcess
      : databaseUrlFromRepoEnvFile();
  if (url !== undefined && url !== "") return baseUrlToE2eUrl(url);
  if (process.env["E2E_REQUIRED"] === "1") {
    throw new Error(
      "E2E_REQUIRED=1 but DATABASE_URL is not set; the walking-skeleton " +
        "suite would be skipped. Set DATABASE_URL to a reachable Postgres.",
    );
  }
  return undefined;
}

/**
 * Pull DATABASE_URL from a dotenv-style file body. Ignores blanks and
 * comments; trims; strips one layer of surrounding quotes. Last match
 * wins. Does not expand interpolations.
 */
export function parseEnvFileDatabaseUrl(text: string): string | undefined {
  let found: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith("DATABASE_URL=")) continue;
    let value = line.slice("DATABASE_URL=".length).trim();
    if (value.length >= 2) {
      const start = value[0];
      const end = value[value.length - 1];
      if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
        value = value.slice(1, -1);
      }
    }
    found = value;
  }
  if (found === undefined || found === "") return undefined;
  return found;
}

function databaseUrlFromRepoEnvFile(): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return parseEnvFileDatabaseUrl(text);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * The suite tears its schema down and rebuilds it on every run, so it
 * must never run inside the developer's own database. It derives a
 * sibling database (same server, name suffixed `_e2e`) and owns that
 * one outright; scripts/db-setup.ts creates it on first use.
 */
export function baseUrlToE2eUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(
      `DATABASE_URL names no database (empty path): ${databaseUrl}. ` +
        "Expected e.g. postgres://localhost:5432/workbench.",
    );
  }
  url.pathname = `/${database}_e2e`;
  return url.toString();
}

// --- hop naming -------------------------------------------------------

/**
 * Run one hop of the skeleton. On failure the thrown error names the
 * hop, so a broken skeleton reports "which hop" instead of a bare
 * assertion dump.
 */
export async function hop<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(
      `walking-skeleton hop "${name}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

// --- shared cleanup registry -------------------------------------------

/**
 * One `afterAll`-backed cleanup registry per suite: `tempDir` mkdtemps
 * under the OS temp dir and queues its removal, `track` queues a
 * spawned app's `stop()`. Registered cleanups run last-in-first-out
 * once the suite's tests finish, whether they passed or failed — the
 * same guarantee every e2e suite used to hand-roll with its own
 * `cleanups` array and `try`/`finally`.
 */
/**
 * LIFO sweep over registered cleanups. Every cleanup runs even when an
 * earlier one throws — a failing hub.stop() must not leak the temp dirs
 * registered before it. The first failure still surfaces (rethrown after
 * the sweep).
 */
export async function runCleanups(
  cleanups: (() => Promise<void> | void)[],
): Promise<void> {
  let firstFailure: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (cause) {
      firstFailure ??= cause;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

export function createCleanupHarness(): {
  tempDir(prefix: string): Promise<string>;
  track(app: SpawnedApp): void;
} {
  const cleanups: (() => Promise<void>)[] = [];

  // Each tracked app's own `stop()` can take up to 5s (SIGTERM, then
  // SIGKILL after a 5s timeout) before it resolves; a suite that tracks
  // more than one — e.g. a restart-shaped suite stopping an old hub, a
  // fresh hub, and a sidecar — can exceed bun's own 5s default hook
  // timeout purely on cleanup, never on the suite's own assertions.
  // Generous enough for a handful of tracked apps stopping in the worst
  // case (every one hitting its own SIGKILL fallback) without becoming
  // the outer suite timeout itself.
  afterAll(async () => {
    await runCleanups(cleanups);
  }, 30_000);

  return {
    async tempDir(prefix) {
      const dir = await mkdtemp(path.join(tmpdir(), prefix));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      return dir;
    },
    track(app) {
      cleanups.push(() => app.stop());
    },
  };
}

// --- hub-resolved postgres client ------------------------------------

interface SqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

/**
 * A single-connection postgres client resolved through the hub's own
 * dependency tree, connected to the e2e database. Used only for
 * harness-side facts the platform has no route for (provisioning the
 * sidecar identity row, exactly as Interchange's dev provisioning
 * does).
 */
export async function connectE2eDb(databaseUrl: string): Promise<SqlClient> {
  const resolved = Bun.resolveSync("postgres", HUB_DIR);
  const { default: postgres } = (await import(resolved)) as {
    default: (options: Record<string, unknown>) => SqlClient;
  };
  const url = new URL(databaseUrl);
  return postgres({
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    max: 1,
    onnotice: () => undefined,
  });
}

/**
 * Write the sidecar's identity row: the hub authenticates a sidecar's
 * WebSocket dial-in against the token hash on the `sidecar` table, so
 * the row must exist before the sidecar process starts. Mirrors
 * Interchange's dev provisioning (id + sha256(token), placeholder url).
 */
export async function provisionSidecar(
  databaseUrl: string,
  sidecarId: string,
  token: string,
): Promise<void> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const sql = await connectE2eDb(databaseUrl);
  try {
    await sql.unsafe(
      `INSERT INTO "sidecar" ("id", "url", "token_hash_sha256") VALUES ($1, $2, $3)`,
      [sidecarId, "ws://e2e-sidecar", Buffer.from(digest)],
    );
  } finally {
    await sql.end();
  }
}

// --- spawned processes ------------------------------------------------

export interface SpawnedApp {
  readonly label: string;
  /** Combined stdout+stderr captured so far. */
  output(): string;
  /** True once the process has exited. */
  exited(): boolean;
  stop(): Promise<void>;
}

function spawnApp(
  label: string,
  cwd: string,
  env: Record<string, string>,
): SpawnedApp {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let captured = "";
  let done = false;
  // A killed-and-restarted process's output is otherwise only reachable
  // through the handle the suite still holds; teeing to a file makes a
  // crash-recovery run diagnosable after the fact.
  const logDir = process.env["E2E_LOG_DIR"];
  const logPath =
    logDir === undefined
      ? undefined
      : `${logDir}/${label}-${String(proc.pid)}.log`;
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      captured += text;
      if (logPath !== undefined) await Bun.write(logPath, captured);
    }
  };
  void capture(proc.stdout);
  void capture(proc.stderr);
  void proc.exited.then(() => {
    done = true;
  });
  return {
    label,
    output: () => captured,
    exited: () => done,
    stop: async () => {
      if (done) return;
      proc.kill();
      const timeout = new Promise<"timeout">((resolveWait) =>
        setTimeout(() => resolveWait("timeout"), 5000),
      );
      if ((await Promise.race([proc.exited, timeout])) === "timeout") {
        proc.kill(9);
        await proc.exited;
      }
    },
  };
}

/**
 * OS facts forwarded into every spawned process; nothing else is
 * inherited. USER is in the list because a DATABASE_URL without a
 * username makes the postgres client resolve the role from it — a
 * local-Postgres setup (see .env.example) authenticates as the OS user.
 */
function osEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface HubHandle extends SpawnedApp {
  readonly baseUrl: string;
}

/**
 * Boot the hub as a real process against the e2e database and wait
 * until its platform /status route answers. An early exit or a boot
 * that never answers fails with the hub's own output attached.
 */
export async function startHub(options: {
  databaseUrl: string;
  port: number;
  sessionSecret: string;
  dataDir: string;
  /** Extra hub config env vars, e.g. SIGNUP_RATE_LIMIT_MAX for a
   * caller whose own bootstrap traffic needs headroom in the limit. */
  extraEnv?: Record<string, string>;
}): Promise<HubHandle> {
  const baseUrl = `http://localhost:${options.port}`;
  const app = spawnApp("hub", HUB_DIR, {
    ...osEnv(),
    // e2e hubs always allow signup, serve apps/hub/public, and advertise
    // BASE_URL as their own listen address by default; a caller's
    // extraEnv can still override any of these (e.g. a real web build's
    // dist dir, or a public BASE_URL that differs from the actual listen
    // port — see PORT below — for a browser-driven suite fronted by a
    // dev-server proxy).
    WORKBENCH_SIGNUP: "open",
    HUB_STATIC_DIR: "public",
    BASE_URL: baseUrl,
    ...options.extraEnv,
    DATABASE_URL: options.databaseUrl,
    // Always the real bind port, independent of whatever port BASE_URL's
    // own origin names — this is the same PORT/BASE_URL split the hub's
    // own config already documents for a reverse proxy in front of it
    // (config.ts's PORT field); it is what lets a caller's extraEnv
    // point BASE_URL at a fronting dev server without also moving where
    // the hub actually listens.
    PORT: String(options.port),
    SESSION_SECRET: options.sessionSecret,
    HUB_DATA_DIR: options.dataDir,
    // The e2e suite never configures CREDENTIAL_ENCRYPTION_KEY; opt into
    // the hub's dev/test fallback so boot doesn't hard-fail here.
    ALLOW_PLAINTEXT_SECRETS: "1",
    // e2e accounts sign up over the wire with no mail delivery, so their
    // emails can never verify; opt into the dev/test escape hatch.
    ALLOW_UNVERIFIED_EMAILS: "1",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (app.exited()) {
      throw new Error(`hub exited during boot; output:\n${app.output()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/status`);
      if (res.status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await app.stop();
      throw new Error(
        `hub did not answer /status within 30s; output:\n${app.output()}`,
      );
    }
    await Bun.sleep(250);
  }
  return { ...app, baseUrl };
}

/**
 * Boot the sidecar as a real process, pointed at the hub's WebSocket
 * dial-in route with the provisioned identity. Connection readiness is
 * observed by the deploy call itself (the hub answers 502 until a
 * sidecar is connected), so this only guards against an immediate
 * crash.
 */
export function startSidecar(options: {
  hubPort: number;
  sidecarId: string;
  token: string;
  dataDir: string;
}): SpawnedApp {
  return spawnApp("sidecar", SIDECAR_DIR, {
    ...osEnv(),
    SIDECAR_DATA_DIR: options.dataDir,
    HUB_WS_URL: `ws://localhost:${options.hubPort}/api/sidecars/ws`,
    SIDECAR_ID: options.sidecarId,
    SIDECAR_TOKEN: options.token,
  });
}

/** An OS-assigned free TCP port (bound briefly, then released). */
export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) throw new Error("could not allocate a free port");
  return port;
}

// --- authenticated API calls -----------------------------------------

export interface ApiResult {
  status: number;
  data: unknown;
  cookies: string[];
}

function mergeCookies(existing: string[], setCookies: string[]): string[] {
  const out = [...existing];
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";")[0];
    const name = pair?.split("=")[0];
    if (pair === undefined || name === undefined || name === "") continue;
    const index = out.findIndex((c) => c.startsWith(`${name}=`));
    if (index >= 0) out[index] = pair;
    else out.push(pair);
  }
  return out;
}

/**
 * One JSON API call with cookie-jar semantics: send the given cookies,
 * fold any Set-Cookie headers into the returned jar. Matches how the
 * browser client holds a better-auth session.
 */
export async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
  cookies: string[] = [],
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  const nextCookies = mergeCookies(cookies, res.headers.getSetCookie());
  const contentType = res.headers.get("content-type") ?? "";
  const data: unknown = contentType.includes("json") ? await res.json() : null;
  return { status: res.status, data, cookies: nextCookies };
}

export function expectStatus(
  what: string,
  result: ApiResult,
  expected: number,
): void {
  if (result.status !== expected) {
    throw new Error(
      `${what}: expected HTTP ${expected}, got ${result.status}: ` +
        JSON.stringify(result.data),
    );
  }
}

// --- keyless-by-construction guard -------------------------------------

/**
 * Real inference provider hosts. This is not a repo-wide invariant —
 * each e2e suite chooses per file whether it stays zero-network: a
 * suite that pins every inference source at the hub's own
 * noop-inference endpoint or an unreachable placeholder host imports
 * this guard and calls it at every baseURL/apiKey it constructs, so an
 * accidental live-provider reference fails immediately instead of
 * silently attempting a real call. A suite that deliberately does dial
 * a real provider host (`chat.test.ts`'s echo-invite test, and
 * `local-rip.test.ts`'s task leg — see each file's own header comment
 * for why) skips this guard on purpose and says so inline, rather than
 * importing it and then routing around it. `startHub` only forwards an
 * explicit env allowlist (see `osEnv`), so a real ANTHROPIC_API_KEY
 * sitting in a developer's shell never reaches the spawned hub either
 * way; this guard is the second, explicit line of defense for the
 * suites that opt into it.
 */
const REAL_PROVIDER_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
  "api-inference.huggingface.co",
  "huggingface.co",
];

/**
 * Fails loudly if `value` (a baseURL, apiKey, or any other string a
 * test is about to hand the hub as an inference source) names a real
 * provider host. Call this at every point a smoke test builds a
 * catalog/credential/deployment source, so an accidental live-provider
 * reference fails the test immediately instead of silently attempting
 * a real network call.
 */
export function assertNeverRealProvider(value: string, what: string): void {
  const lower = value.toLowerCase();
  const hit = REAL_PROVIDER_HOSTS.find((host) => lower.includes(host));
  if (hit !== undefined) {
    throw new Error(
      `${what} references a real inference provider host ("${hit}"); ` +
        "the e2e suite must never reach a live provider — use the hub's " +
        "own noop-inference endpoint or an unreachable placeholder host " +
        "instead.",
    );
  }
}

export type RunEvent = { seq: number; type: string; body: unknown };

function runEvents(data: unknown): RunEvent[] {
  if (
    typeof data === "object" &&
    data !== null &&
    "events" in data &&
    Array.isArray((data as Record<string, unknown>)["events"])
  ) {
    return (data as { events: RunEvent[] }).events;
  }
  throw new Error(`expected a run events array: ${JSON.stringify(data)}`);
}

const TERMINAL_EVENT_TYPES = ["RunCompleted", "RunFailed", "RunCancelled"];

/**
 * Polls a run's event log until a terminal event lands, then requires
 * it to be `RunCompleted` — not merely that the run started. A trigger
 * accepted by the hub only proves the mail route works; a broken
 * agent launch, a wedged inference call, or a rejected step surfaces
 * as `RunFailed` (or no terminal event at all before the deadline),
 * either of which fails this loudly instead of a workflow silently
 * "succeeding" on nothing more than its own acceptance.
 */
export async function waitForRunCompletion(
  baseUrl: string,
  tenantId: string,
  deploymentId: string,
  runId: string,
  cookies: string[],
  timeoutMs: number,
): Promise<RunEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(
      baseUrl,
      "GET",
      `/api/tenants/${tenantId}/workflows/${deploymentId}/runs/${runId}/events`,
      undefined,
      cookies,
    );
    expectStatus("read run events", res, 200);
    const events = runEvents(res.data);
    const terminal = events.find((e) => TERMINAL_EVENT_TYPES.includes(e.type));
    if (terminal !== undefined) {
      if (terminal.type !== "RunCompleted") {
        throw new Error(
          `run ${runId} ended in ${terminal.type}, not RunCompleted: ` +
            JSON.stringify(terminal.body),
        );
      }
      return events;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} reached no terminal event within ${Math.round(timeoutMs / 1000)}s; ` +
          `events so far: ${JSON.stringify(events)}`,
      );
    }
    await Bun.sleep(500);
  }
}

/**
 * Asserts the run's event log recorded a completed step with the
 * given step id — the actual per-step execution, not just the run's
 * own start/stop bookkeeping.
 */
export function expectStepCompleted(events: RunEvent[], stepId: string): void {
  const completed = events.find(
    (e) =>
      e.type === "StepCompleted" &&
      typeof e.body === "object" &&
      e.body !== null &&
      "stepId" in e.body &&
      (e.body as Record<string, unknown>)["stepId"] === stepId,
  );
  if (completed === undefined) {
    throw new Error(
      `no StepCompleted event for step "${stepId}"; events: ${JSON.stringify(events)}`,
    );
  }
}

// --- workflow asset content over git smart-HTTP -----------------------

/**
 * Publishes a workflow definition into its asset repo in the one shape
 * a `workflow`-kind asset accepts: the source codebase
 * `@corbits/workflow-source` renders. Delegates to the platform's own
 * pusher so the suite exercises the same publication path the seed and
 * the product use, and returns the commit a code-sourced deploy pins.
 */
export async function pushWorkflowSource(options: {
  baseUrl: string;
  tenantId: string;
  assetName: string;
  tokenSecret: string;
  workflowJson: string;
}): Promise<{ commitSha: string }> {
  const pushed = await createGitWorkflowPusher()({
    remoteUrl: `${options.baseUrl}/api/tenants/${options.tenantId}/assets/workflow/${options.assetName}.git`,
    tokenSecret: options.tokenSecret,
    workflowJson: options.workflowJson,
    packageName: options.assetName,
  });
  return { commitSha: pushed.commitSha };
}

/**
 * The deploy body a code-sourced asset deployment takes: the pushed
 * commit is the definition's pin, and the entry names the
 * `interchange.workflow` module the sidecar evaluates.
 */
export function workflowDeployBody(options: {
  assetId: string;
  commitSha: string;
  sourceId: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}): Record<string, unknown> {
  return {
    source: {
      kind: "asset",
      assetId: options.assetId,
      package: { format: "source", commitSha: options.commitSha },
    },
    entry: WORKFLOW_SOURCE_ENTRY,
    sources: [
      {
        id: options.sourceId,
        provider: options.provider,
        baseURL: options.baseURL,
        apiKey: options.apiKey,
        model: options.model,
      },
    ],
    defaultSource: options.sourceId,
  };
}
