// Harness for the end-to-end walking skeleton. Everything here exists
// to run the real stack — the hub and sidecar as spawned processes
// against a real Postgres — and to make a failing hop name itself.
// Nothing platform-side is mocked; when a hop cannot be exercised for
// real the suite fails and says which hop, it never fakes the result.

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
 */
export function e2eDatabaseUrl(): string | undefined {
  const url = process.env["DATABASE_URL"];
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
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      captured += decoder.decode(chunk, { stream: true });
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
}): Promise<HubHandle> {
  const baseUrl = `http://localhost:${options.port}`;
  const app = spawnApp("hub", HUB_DIR, {
    ...osEnv(),
    DATABASE_URL: options.databaseUrl,
    BASE_URL: baseUrl,
    SESSION_SECRET: options.sessionSecret,
    HUB_DATA_DIR: options.dataDir,
    HUB_STATIC_DIR: "public",
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
    body: body === undefined ? undefined : JSON.stringify(body),
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

// --- workflow asset content over git smart-HTTP -----------------------

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Uint8Array) => {
      stdout += new TextDecoder().decode(chunk);
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      stderr += new TextDecoder().decode(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({ status: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Commit `workflow.json` into a workflow asset over the platform's
 * asset smart-HTTP route — the only surface that writes asset tree
 * content — using the system git binary with a bearer-token askpass
 * shim, exactly as the platform's own tooling does.
 */
export async function pushWorkflowJson(options: {
  baseUrl: string;
  tenantId: string;
  assetName: string;
  tokenSecret: string;
  workflowJson: string;
}): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "e2e-workflow-push-"));
  try {
    const askpass = path.join(work, "askpass.sh");
    await writeFile(
      askpass,
      `#!/bin/sh\nprintf '%s\\n' '${options.tokenSecret.replace(/'/g, "'\\''")}'\n`,
      "utf-8",
    );
    await chmod(askpass, 0o755);
    const env: Record<string, string> = {
      ...osEnv(),
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Walking Skeleton",
      GIT_AUTHOR_EMAIL: "e2e@workbench.invalid",
      GIT_COMMITTER_NAME: "Walking Skeleton",
      GIT_COMMITTER_EMAIL: "e2e@workbench.invalid",
    };
    const remote = new URL(
      `${options.baseUrl}/api/tenants/${options.tenantId}/assets/workflow/${options.assetName}.git`,
    );
    remote.username = "x-access-token";
    remote.password = encodeURIComponent(options.tokenSecret);
    const repoDir = path.join(work, "repo");

    const clone = await runGit(
      ["-c", "credential.helper=", "clone", remote.toString(), repoDir],
      work,
      env,
    );
    if (clone.status !== 0) {
      throw new Error(`git clone of workflow asset failed: ${clone.stderr}`);
    }

    await writeFile(
      path.join(repoDir, "workflow.json"),
      options.workflowJson,
      "utf-8",
    );
    for (const step of [
      { label: "add workflow.json", args: ["add", "workflow.json"] },
      {
        label: "commit workflow.json",
        args: [
          "-c",
          "user.name=Walking Skeleton",
          "-c",
          "user.email=e2e@workbench.invalid",
          "commit",
          "-m",
          "Add echo workflow definition",
        ],
      },
      {
        label: "push workflow.json",
        args: ["-c", "credential.helper=", "push", "origin", "HEAD:main"],
      },
    ]) {
      const result = await runGit(step.args, repoDir, env);
      if (result.status !== 0) {
        throw new Error(
          `git ${step.label} failed: ${result.stderr || result.stdout}`,
        );
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
