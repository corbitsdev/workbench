#!/usr/bin/env bun

/**
 * Bulk-delete agent instances for a tenant. Lists every instance (paginating
 * the catalog), optionally filters, prints a breakdown by agent + status, then
 * deletes each after an explicit confirmation.
 *
 * Filters (all optional, combinable), passed as `--flag value`:
 *   --status <deployed|running|updating|error|stopped>  only this status
 *   --agent  <substring>   only instances whose agent name contains this
 *   --prefix <string>      only instance ids starting with this (e.g.
 *                          `ins_ses_` for workflow-step leftovers)
 *   --yes                  skip the interactive confirm (for scripted runs)
 *
 * Tenant is selected the same way as the other bin scripts (`--tenant <slug>`
 * via the admin CLI, or WORKBENCH_SLUG). Run with an authenticated superadmin
 * (email/password) or a SESSION_TOKEN.
 */

import { resolveTargetTenant } from "./_lib";

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const BASE = env("HUB_URL", "http://localhost:4000") as string;
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com") as string;
const PASSWORD = env("SUPERADMIN_PASS", "password123") as string;
const GLOBAL_SLUG = env("GLOBAL_TENANT_SLUG", "abklabs") as string;
const SESSION_TOKEN = process.env["SESSION_TOKEN"];

type CookieJar = string[];

async function api(
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = [],
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");
  const res = await fetch(`${BASE}${path}`, {
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

function log(message: string) {
  console.log(`[cleanup-instances] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[cleanup-instances] FAIL ${label}: ${status}`);
  console.error(`[cleanup-instances]   ${JSON.stringify(data)}`);
  process.exit(1);
}

export type InstanceRow = {
  id: string;
  agentName?: string;
  status?: string;
  createdAt?: string;
};

// Parse `--flag value` pairs and bare `--flag` booleans from argv.
export function parseFlags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

// Apply the optional status/agent/prefix filters to the listed instances.
export function applyFilters(
  rows: readonly InstanceRow[],
  filters: { status?: string; agent?: string; prefix?: string },
): InstanceRow[] {
  return rows.filter((r) => {
    if (filters.status && r.status !== filters.status) return false;
    if (
      filters.agent &&
      !(r.agentName ?? "").toLowerCase().includes(filters.agent.toLowerCase())
    )
      return false;
    if (filters.prefix && !r.id.startsWith(filters.prefix)) return false;
    return true;
  });
}

// Ephemeral workflow step/supervisor instances carry a session-derived id
// (`ins_ses_…`). The hub's delete handler only hard-deletes (and thus frees the
// underlying agent_instance row) when `?hard=true` is set, and it restricts the
// hard path to these ids. A soft stop leaves the row for the admin list to
// re-surface forever, so cleanup never converges. Request a hard delete for
// ephemeral ids; fall back to a plain (soft) delete for everything else so a
// user chat agent's history is never destroyed.
const EPHEMERAL_INSTANCE_PREFIX = "ins_ses_";

export function buildDeleteUrl(tenantId: string, instanceId: string): string {
  const base = `/api/v1/tenants/${tenantId}/agents/instances/${instanceId}`;
  if (instanceId.startsWith(EPHEMERAL_INSTANCE_PREFIX)) {
    return `${base}?hard=true`;
  }
  return base;
}

// Count instances by "<agentName> · <status>" for the pre-delete summary.
export function breakdown(rows: readonly InstanceRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.agentName ?? "?"} · ${r.status ?? "?"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function listAllInstances(
  tenantId: string,
  cookies: CookieJar,
): Promise<InstanceRow[]> {
  const all: InstanceRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const res = await api(
      "GET",
      `/api/tenants/${tenantId}/agents/instances?${qs.toString()}`,
      undefined,
      cookies,
    );
    if (res.status !== 200) fail("list instances", res.status, res.data);
    const body = res.data as {
      data?: InstanceRow[];
      nextCursor?: string;
    };
    all.push(...(body.data ?? []));
    if (typeof body.nextCursor !== "string" || (body.data ?? []).length === 0)
      break;
    cursor = body.nextCursor;
  }
  return all;
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2));

  let cookies: CookieJar;
  if (SESSION_TOKEN) {
    log("Using SESSION_TOKEN for authentication");
    cookies = [
      `better-auth.session_token=${SESSION_TOKEN}`,
      `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
    ];
  } else {
    const signIn = await api("POST", "/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });
    if (signIn.cookies.length === 0)
      fail("sign in", signIn.status, signIn.data);
    cookies = signIn.cookies;
    log(`Signed in as ${EMAIL}`);
  }

  const target = await resolveTargetTenant({
    base: BASE,
    cookies,
    argv: process.argv.slice(2),
    envVar: "WORKBENCH_SLUG",
    globalSlug: GLOBAL_SLUG,
  });
  log(`Tenant: ${target.name} [${target.slug}] (${target.tenantId})`);

  const all = await listAllInstances(target.tenantId, cookies);
  const filters = {
    ...(flags["status"] ? { status: flags["status"] } : {}),
    ...(flags["agent"] ? { agent: flags["agent"] } : {}),
    ...(flags["prefix"] ? { prefix: flags["prefix"] } : {}),
  };
  const matched = applyFilters(all, filters);

  log(`${all.length} instance(s) total, ${matched.length} match the filter.`);
  for (const [key, count] of breakdown(matched)) {
    log(`  ${count.toString().padStart(4)} × ${key}`);
  }
  if (matched.length === 0) {
    log("Nothing to delete.");
    process.exit(0);
  }

  if (flags["yes"] !== "true") {
    const answer = prompt(
      `Delete ${matched.length} instance(s) on "${target.slug}"? Type the count to confirm:`,
    );
    if (answer !== String(matched.length)) {
      log("Aborted (confirmation did not match).");
      process.exit(1);
    }
  }

  let deleted = 0;
  for (const row of matched) {
    const res = await api(
      "DELETE",
      buildDeleteUrl(target.tenantId, row.id),
      undefined,
      cookies,
    );
    if (res.status !== 204 && res.status !== 200) {
      log(`  FAILED ${row.id}: ${res.status} ${JSON.stringify(res.data)}`);
      continue;
    }
    deleted++;
    if (deleted % 25 === 0) log(`  deleted ${deleted}/${matched.length}…`);
  }
  log(`Done. Deleted ${deleted}/${matched.length}.`);
}
