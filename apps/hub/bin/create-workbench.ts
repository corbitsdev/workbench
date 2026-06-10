#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Create a named workbench tenant and optionally add an owner by email.
 *
 * Usage:
 *   bun apps/hub/bin/create-workbench.ts --name "Acme Sales" [--owner-email user@example.com]
 *
 * Auth: set SESSION_TOKEN to a better-auth session cookie, or fall back to
 * email/password where that auth mode is enabled.
 *
 * Env:
 *   HUB_URL           — hub base URL (default http://localhost:4000)
 *   SESSION_TOKEN     — better-auth session token (preferred in prod/staging)
 *   SUPERADMIN_EMAIL  — email for password sign-in (default alice@example.com)
 *   SUPERADMIN_PASS   — password for sign-in (default password123)
 */

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const BASE = env('HUB_URL', 'http://localhost:4000') as string;
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com') as string;
const PASSWORD = env('SUPERADMIN_PASS', 'password123') as string;
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

type CookieJar = string[];

async function api(
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = []
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const nextCookies = [...cookies];
  for (const sc of res.headers.getSetCookie()) {
    const name = sc.split('=')[0];
    const value = sc.split(';')[0];
    if (!name || !value) continue;
    const idx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) nextCookies[idx] = value;
    else nextCookies.push(value);
  }

  let data: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

function log(message: string) {
  console.log(`[create-workbench] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[create-workbench] FAIL ${label}: ${status}`);
  console.error(`[create-workbench]   ${JSON.stringify(data)}`);
  process.exit(1);
}

// Parse args
const args = process.argv.slice(2);
let name: string | undefined;
let ownerEmail: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name' && args[i + 1]) {
    name = args[++i];
  } else if (args[i] === '--owner-email' && args[i + 1]) {
    ownerEmail = args[++i];
  }
}

if (!name) {
  console.error(
    '[create-workbench] Usage: create-workbench.ts --name <name> [--owner-email <email>]'
  );
  process.exit(1);
}

// Auth
let cookies: CookieJar;
if (SESSION_TOKEN) {
  log('Using SESSION_TOKEN for authentication');
  cookies = [
    `better-auth.session_token=${SESSION_TOKEN}`,
    `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
  ];
} else {
  const signIn = await api('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  if (signIn.cookies.length === 0) fail('sign in', signIn.status, signIn.data);
  cookies = signIn.cookies;
  log(`Signed in as ${EMAIL}`);
}

// Create workbench
const createRes = await api('POST', '/api/v1/workbenches', { name }, cookies);
if (createRes.status !== 200 && createRes.status !== 201) {
  fail('create workbench', createRes.status, createRes.data);
}

const workbench = createRes.data as { id: string; name: string; slug: string; tenantId: string };
log(
  `Workbench created: ${workbench.name} (slug: ${workbench.slug}, tenantId: ${workbench.tenantId})`
);

// Optionally invite owner
if (ownerEmail) {
  const inviteRes = await api(
    'POST',
    `/api/tenants/${workbench.tenantId}/members/invite`,
    { email: ownerEmail },
    cookies
  );
  if (inviteRes.status !== 200 && inviteRes.status !== 201) {
    fail(`invite owner ${ownerEmail}`, inviteRes.status, inviteRes.data);
  }
  log(`Owner invited: ${ownerEmail}`);
}
