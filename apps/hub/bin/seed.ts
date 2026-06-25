#!/usr/bin/env bun
/**
 * GTM Workbench seed script for local dev.
 *
 * Creates/signs in the default local user, triggers existing provisioning, and
 * promotes that user's global principal to the existing Interchange `owner`
 * role so admin-ui can read agent definitions/roles/grants/etc.
 *
 * This script does NOT create agent definitions. Hub boot seeds those through
 * seedAgentTemplates(db) from @workbench/agents.
 *
 * For production use, run seed-prod.ts instead.
 */

import postgres from "postgres";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[seed] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const BASE = env("HUB_URL", "http://localhost:4000");
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com");
const NAME = env("SUPERADMIN_NAME", "Alice Admin");
const PASSWORD = env("SUPERADMIN_PASS", "password123");

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
  console.log(`[seed] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[seed] FAIL ${label}: ${status}`);
  console.error(`[seed]   ${JSON.stringify(data)}`);
  process.exit(1);
}

log(`Authenticating ${EMAIL}...`);

const signUp = await api("POST", "/api/auth/sign-up/email", {
  name: NAME,
  email: EMAIL,
  password: PASSWORD,
});

let cookies = signUp.cookies;
let authData = signUp.data;

if (cookies.length === 0) {
  const signIn = await api("POST", "/api/auth/sign-in/email", {
    email: EMAIL,
    password: PASSWORD,
  });
  if (signIn.cookies.length === 0) fail("sign in", signIn.status, signIn.data);
  cookies = signIn.cookies;
  authData = signIn.data;
  log("  Signed in existing user");
} else {
  log("  Created user");
}

const userId = (
  (authData as Record<string, unknown>)?.user as { id?: string } | undefined
)?.id;
if (!userId) {
  console.error("[seed] Auth response did not include user.id");
  process.exit(1);
}
log(`  User ID: ${userId}`);

// This route triggers existing repair/provisioning. Agent definitions are
// already Interchange agent rows seeded at hub boot by seedAgentTemplates(db).
const me = await api("POST", "/api/v1/me", {}, cookies);
if (me.status !== 200) fail("/api/v1/me", me.status, me.data);

const body = me.data as Record<string, unknown>;
const tenantId = String(body.personalTenantId ?? "");
if (!tenantId) {
  console.error("[seed] /api/v1/me did not return personalTenantId");
  process.exit(1);
}
log(`  Tenant ID: ${tenantId}`);
log(`  Myra instance ID: ${String(body.paInstanceId ?? "(none)")}`);

log("Promoting user principal to Interchange owner role...");
const sql = postgres(requireEnv("DATABASE_URL"), { max: 1 });
try {
  const [principal] = await sql<{ id: string }[]>`
    select id from principal
    where tenant_id = ${tenantId}
      and kind = 'user'
      and ref_id = ${userId}
    limit 1
  `;
  if (!principal) {
    console.error("[seed] Could not find global user principal");
    process.exit(1);
  }

  const [ownerRole] = await sql<{ id: string }[]>`
    select id from role
    where tenant_id = ${tenantId}
      and name = 'owner'
    limit 1
  `;
  if (!ownerRole) {
    console.error("[seed] Could not find global owner role");
    process.exit(1);
  }

  await sql`
    insert into principal_role (principal_id, role_id, created_at)
    values (${principal.id}, ${ownerRole.id}, now())
    on conflict do nothing
  `;
  log(`  Principal ${principal.id} has owner role ${ownerRole.id}`);
} finally {
  await sql.end();
}

log("Seed completed successfully.");
log(`\n  Email:    ${EMAIL}`);
log(`  Password: ${PASSWORD}`);
