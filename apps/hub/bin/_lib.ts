/* eslint-disable no-console */

/**
 * Shared utilities for hub admin scripts.
 */

export type CookieJar = string[];

export function env(name: string, fallback: string): string;
export function env(name: string, fallback?: string): string | undefined;
export function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = [],
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  const nextCookies = [...cookies];
  for (const sc of res.headers.getSetCookie()) {
    const name = sc.split("=")[0];
    const value = sc.split(";")[0];
    if (!name || !value) continue;
    const idx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) nextCookies[idx] = value;
    else nextCookies.push(value);
  }

  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json"))
    data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

export function makeLogger(prefix: string): (message: string) => void {
  return (message: string) => console.log(`[${prefix}] ${message}`);
}

export function makeFail(
  prefix: string,
): (label: string, status: number, data: unknown) => never {
  return (label: string, status: number, data: unknown): never => {
    console.error(`[${prefix}] FAIL ${label}: ${status}`);
    console.error(`[${prefix}]   ${JSON.stringify(data)}`);
    process.exit(1);
  };
}

export type TargetTenant = { tenantId: string; slug: string; name: string };

type PrincipalRow = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
};

function parsePrincipals(data: unknown): PrincipalRow[] {
  const rows = (data as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  const out: PrincipalRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { tenantId, tenantSlug, tenantName } = row as Record<string, unknown>;
    if (typeof tenantId !== "string" || typeof tenantSlug !== "string")
      continue;
    out.push({
      tenantId,
      tenantSlug,
      tenantName: typeof tenantName === "string" ? tenantName : tenantSlug,
    });
  }
  return out;
}

function readTenantFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tenant") return argv[i + 1];
    if (arg?.startsWith("--tenant=")) return arg.slice("--tenant=".length);
  }
  return undefined;
}

/**
 * Resolve the tenant an admin script should target.
 *
 * Precedence: a `--tenant <slug>` flag (or the named env var) wins; otherwise,
 * if stdin is a TTY the caller picks interactively from their principals;
 * otherwise (CI / non-TTY with no flag) it defaults to the global tenant so
 * unattended runs never hang. The chosen slug must be one the caller is a
 * principal of — Interchange resolves catalog/credentials/workflows down the
 * tenant hierarchy, so "scope X to a sub-tenant" = "target that sub-tenant".
 */
export async function resolveTargetTenant(opts: {
  base: string;
  cookies: CookieJar;
  argv: string[];
  envVar?: string;
  globalSlug?: string;
}): Promise<TargetTenant> {
  const globalSlug =
    opts.globalSlug ?? process.env["GLOBAL_TENANT_SLUG"] ?? "abklabs";
  const res = await api(
    opts.base,
    "GET",
    "/api/me/principals",
    undefined,
    opts.cookies,
  );
  if (res.status !== 200) {
    throw new Error(
      `resolveTargetTenant: /api/me/principals failed: ${String(res.status)}`,
    );
  }
  const principals = parsePrincipals(res.data);
  if (principals.length === 0) {
    throw new Error(
      "resolveTargetTenant: caller is not a principal of any tenant",
    );
  }

  const toTarget = (p: PrincipalRow): TargetTenant => ({
    tenantId: p.tenantId,
    slug: p.tenantSlug,
    name: p.tenantName,
  });

  const flagSlug =
    readTenantFlag(opts.argv) ??
    (opts.envVar ? process.env[opts.envVar] : undefined) ??
    undefined;

  if (flagSlug !== undefined && flagSlug !== "") {
    const match = principals.find((p) => p.tenantSlug === flagSlug);
    if (!match) {
      throw new Error(
        `resolveTargetTenant: caller is not a principal of tenant "${flagSlug}"`,
      );
    }
    return toTarget(match);
  }

  const globalMatch =
    principals.find((p) => p.tenantSlug === globalSlug) ?? principals[0];
  if (!globalMatch) {
    throw new Error("resolveTargetTenant: no resolvable tenant");
  }

  if (!process.stdin.isTTY) {
    return toTarget(globalMatch);
  }

  console.log("Select a target tenant:");
  principals.forEach((p, i) => {
    const marker = p.tenantSlug === globalSlug ? " (global)" : "";
    console.log(`  ${i + 1}) ${p.tenantName} [${p.tenantSlug}]${marker}`);
  });
  const answer = prompt(
    `Tenant [1-${principals.length}, default ${globalMatch.tenantSlug}]:`,
  );
  if (answer === null || answer.trim() === "") return toTarget(globalMatch);
  const index = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(index) || index < 1 || index > principals.length) {
    throw new Error(`resolveTargetTenant: invalid selection "${answer}"`);
  }
  const chosen = principals[index - 1];
  if (!chosen)
    throw new Error(`resolveTargetTenant: invalid selection "${answer}"`);
  return toTarget(chosen);
}

export async function signIn(
  base: string,
  email: string,
  password: string,
  sessionToken: string | undefined,
  log: (msg: string) => void,
  fail: (label: string, status: number, data: unknown) => never,
): Promise<CookieJar> {
  if (sessionToken) {
    log("Using SESSION_TOKEN for authentication");
    return [
      `better-auth.session_token=${sessionToken}`,
      `__Secure-better-auth.session_token=${sessionToken}`,
    ];
  }
  const res = await api(base, "POST", "/api/auth/sign-in/email", {
    email,
    password,
  });
  if (res.cookies.length === 0) fail("sign in", res.status, res.data);
  log(`Signed in as ${email}`);
  return res.cookies;
}
