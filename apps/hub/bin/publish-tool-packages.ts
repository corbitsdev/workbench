// Upload tool-package tarballs to a tenant's `package-registry` asset via
// the hub asset REST API — the "push" half of the pipeline. A thin REST
// client (interchange's equivalent bin leaks `@intx/*` resolution across
// worktrees when driven directly). See docs/CREATING_AGENTS_AND_TOOLS.md.

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type, type Type } from "arktype";

import { AssetResponse, AssetWithOriginResponse } from "@intx/types";
import { WORKSPACE_BUILTINS_REGISTRY } from "@intx/hub-sessions";

import { resolveTargetTenant } from "./_lib";

const TarballPutResponse = type({ commit: "string", integrity: "string" });

export type PublishOptions = {
  hubURL: string;
  // Explicit slug short-circuits the picker (used by the non-interactive
  // package.json scripts). When omitted, resolveTargetTenant picks from the
  // flag / env var / TTY prompt / global default.
  tenantSlug?: string;
  tenantName?: string;
  argv?: string[];
  tenantEnvVar?: string;
  globalSlug?: string;
  registryName: string;
  fromDir: string;
  // Auth: either a pre-minted session token (preferred for CI/deploy — no admin
  // password on the box; bare better-auth token, not a full cookie) or admin
  // email + password to sign in for a session.
  sessionCookie?: string;
  adminEmail?: string;
  adminPassword?: string;
};

export type PublishSummary = {
  filename: string;
  commit: string;
  integrity: string;
};

type CookieJar = string[];
type ApiResult = { status: number; data: unknown; cookies: CookieJar };

function parseSchema<T extends Type>(
  schema: T,
  data: unknown,
  label: string,
): T["infer"] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(
      `publish-tool-packages: validation failed for ${label}: ${result.summary}`,
    );
  }
  return result;
}

function mergeSetCookies(prev: CookieJar, setCookies: string[]): CookieJar {
  const next = [...prev];
  for (const sc of setCookies) {
    const name = sc.split("=")[0];
    const value = sc.split(";")[0];
    if (name === undefined || value === undefined) continue;
    const idx = next.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) next[idx] = value;
    else next.push(value);
  }
  return next;
}

async function jsonApi(
  hubURL: string,
  method: string,
  apiPath: string,
  body: unknown,
  cookies: CookieJar,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookies.length > 0) headers.Cookie = cookies.join("; ");
  const res = await fetch(`${hubURL}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const nextCookies = mergeSetCookies(cookies, res.headers.getSetCookie());
  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    data = await res.json();
  }
  return { status: res.status, data, cookies: nextCookies };
}

async function authenticate(
  hubURL: string,
  email: string,
  password: string,
): Promise<CookieJar> {
  const signUp = await jsonApi(
    hubURL,
    "POST",
    "/api/auth/sign-up/email",
    { name: "Publish Admin", email, password },
    [],
  );
  if (signUp.status === 200) return signUp.cookies;
  // 422 is better-auth's "user already exists" — fall through to sign-in.
  // Anything else is a hub fault that must not masquerade as an auth miss.
  if (signUp.status !== 422) {
    throw new Error(
      `publish-tool-packages: unexpected sign-up response for ${email}: ${String(signUp.status)}`,
    );
  }
  const signIn = await jsonApi(
    hubURL,
    "POST",
    "/api/auth/sign-in/email",
    { email, password },
    [],
  );
  if (signIn.status !== 200) {
    throw new Error(
      `publish-tool-packages: authentication failed for ${email}: ${String(signIn.status)}`,
    );
  }
  return signIn.cookies;
}

async function ensureRegistryAsset(
  hubURL: string,
  cookies: CookieJar,
  tenantId: string,
  registryName: string,
): Promise<string> {
  const list = await jsonApi(
    hubURL,
    "GET",
    `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`,
    undefined,
    cookies,
  );
  if (list.status !== 200) {
    throw new Error(
      `publish-tool-packages: failed to list assets: ${String(list.status)}`,
    );
  }
  const rows = parseSchema(
    AssetWithOriginResponse.array(),
    list.data,
    "list assets response",
  );
  const existing = rows.find((r) => r.name === registryName);
  if (existing !== undefined) return existing.id;
  const create = await jsonApi(
    hubURL,
    "POST",
    `/api/tenants/${tenantId}/assets`,
    { kind: "package-registry", name: registryName },
    cookies,
  );
  if (create.status !== 201) {
    throw new Error(
      `publish-tool-packages: failed to create asset ${registryName}: ${String(create.status)}`,
    );
  }
  return parseSchema(AssetResponse, create.data, "create asset response").id;
}

async function putTarball(
  hubURL: string,
  cookies: CookieJar,
  tenantId: string,
  assetId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ commit: string; integrity: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (cookies.length > 0) headers.Cookie = cookies.join("; ");
  const url = `${hubURL}/api/tenants/${tenantId}/assets/${assetId}/tarballs/${filename}`;
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: bytes,
    redirect: "manual",
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `publish-tool-packages: upload failed for ${filename}: ${String(res.status)} ${text}`,
    );
  }
  return parseSchema(TarballPutResponse, await res.json(), `PUT ${filename}`);
}

async function listTarballs(fromDir: string): Promise<string[]> {
  const entries = await fs.readdir(fromDir);
  const tarballs = entries.filter((f) => f.endsWith(".tgz")).sort();
  if (tarballs.length === 0) {
    throw new Error(
      `publish-tool-packages: no *.tgz files found under ${fromDir}`,
    );
  }
  return tarballs;
}

/**
 * Authenticate, resolve the tenant, ensure the registry asset, and PUT
 * every tarball under `opts.fromDir`. Idempotent — re-running overwrites
 * same-name entries. Returns one record per uploaded file.
 */
// Prefer a pre-minted session token; otherwise sign in with admin creds. Pass
// the bare better-auth session token (grabbed from the browser) — we emit both
// the plain and `__Secure-` cookie variants so it works against http and https
// hubs alike. This matches the convention in the other hub bins (_lib.ts signIn,
// reset-myra, seed-credentials, add-llm-credential).
async function resolveAuthCookies(opts: PublishOptions): Promise<CookieJar> {
  if (opts.sessionCookie !== undefined && opts.sessionCookie !== "") {
    return [
      `better-auth.session_token=${opts.sessionCookie}`,
      `__Secure-better-auth.session_token=${opts.sessionCookie}`,
    ];
  }
  if (opts.adminEmail === undefined || opts.adminPassword === undefined) {
    throw new Error(
      "publish-tool-packages: set HUB_SESSION_COOKIE, or HUB_ADMIN_EMAIL + HUB_ADMIN_PASSWORD",
    );
  }
  return authenticate(opts.hubURL, opts.adminEmail, opts.adminPassword);
}

export async function publishToolPackages(
  opts: PublishOptions,
): Promise<PublishSummary[]> {
  const cookies = await resolveAuthCookies(opts);
  const target = await resolveTargetTenant({
    base: opts.hubURL,
    cookies,
    argv:
      opts.tenantSlug === undefined
        ? (opts.argv ?? [])
        : [`--tenant=${opts.tenantSlug}`],
    envVar: opts.tenantEnvVar,
    globalSlug: opts.globalSlug,
  });
  const tenantId = target.tenantId;
  process.stdout.write(`  tenant: ${target.name} [${target.slug}]\n`);
  const assetId = await ensureRegistryAsset(
    opts.hubURL,
    cookies,
    tenantId,
    opts.registryName,
  );
  const tarballs = await listTarballs(opts.fromDir);

  const summaries: PublishSummary[] = [];
  for (const filename of tarballs) {
    const bytes = await fs.readFile(path.join(opts.fromDir, filename));
    const result = await putTarball(
      opts.hubURL,
      cookies,
      tenantId,
      assetId,
      filename,
      new Uint8Array(bytes),
    );
    summaries.push({ filename, ...result });
  }
  return summaries;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `publish-tool-packages: required environment variable ${name} is not set`,
    );
  }
  return value;
}

async function runCLI(): Promise<void> {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: WORKSPACE_BUILTINS_REGISTRY },
      from: { type: "string", default: "dist/tool-packages" },
      tenant: { type: "string" },
    },
    strict: true,
  });

  const hubURL = requireEnv("HUB_URL");
  // Prefer a session cookie; fall back to admin email + password.
  const sessionCookie = process.env.HUB_SESSION_COOKIE;
  const useSession = sessionCookie !== undefined && sessionCookie !== "";
  const adminEmail = useSession ? undefined : requireEnv("HUB_ADMIN_EMAIL");
  const adminPassword = useSession
    ? undefined
    : requireEnv("HUB_ADMIN_PASSWORD");
  // An explicit slug (flag or HUB_TENANT_SLUG) short-circuits the picker and
  // keeps the tools:push:staging|production scripts non-interactive. With no
  // slug and no TTY, resolveTargetTenant falls through to the global tenant.
  const tenantSlug = values.tenant ?? process.env.HUB_TENANT_SLUG;
  const fromRaw = values.from;
  const fromDir = path.isAbsolute(fromRaw)
    ? fromRaw
    : path.resolve(process.cwd(), fromRaw);

  const summaries = await publishToolPackages({
    hubURL,
    sessionCookie,
    adminEmail,
    adminPassword,
    tenantSlug,
    argv: process.argv.slice(2),
    tenantEnvVar: "HUB_TENANT_SLUG",
    registryName: values.registry,
    fromDir,
  });
  for (const s of summaries) {
    process.stdout.write(
      `  ${s.filename} commit=${s.commit} integrity=${s.integrity}\n`,
    );
  }
}

if (import.meta.main) {
  await runCLI();
}
