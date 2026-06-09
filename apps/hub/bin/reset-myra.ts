#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Resets the calling user's personal agent (Myra) without admin-ui.
 *
 * Reads /api/v1/me to find the current Myra instance, then DELETEs it. The
 * delete tears down the sidecar session and drops the memberAgentInstance
 * mapping, so the next /api/v1/me (i.e. a web app reload) re-provisions a
 * fresh Myra and auto-relaunches it. Use this when Myra is wedged and Google
 * auth (admin-ui) is unavailable.
 *
 * Auth: set SESSION_TOKEN to a better-auth session cookie grabbed from the
 * browser (DevTools -> Application -> Cookies -> __Secure-better-auth.session_token),
 * or fall back to email/password where that auth mode is enabled.
 *
 * Env:
 *   HUB_URL          — hub base URL (default http://localhost:4000)
 *   SESSION_TOKEN    — better-auth session token (preferred in prod/staging)
 *   SUPERADMIN_EMAIL — email for password sign-in (default alice@example.com)
 *   SUPERADMIN_PASS  — password for sign-in (default password123)
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
  console.log(`[reset-myra] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[reset-myra] FAIL ${label}: ${status}`);
  console.error(`[reset-myra]   ${JSON.stringify(data)}`);
  process.exit(1);
}

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

const meRes = await api('GET', '/api/v1/me', undefined, cookies);
if (meRes.status !== 200) fail('/api/v1/me', meRes.status, meRes.data);

const me = meRes.data as { paInstanceId: string | null; personalTenantId: string | null };
if (!me.personalTenantId) {
  console.error('[reset-myra] No working tenant for this user — has the user signed in yet?');
  process.exit(1);
}
if (!me.paInstanceId) {
  log('No Myra instance found — nothing to delete. Reload the web app to provision a fresh one.');
  process.exit(0);
}

log(`Tenant:   ${me.personalTenantId}`);
log(`Myra:     ${me.paInstanceId}`);

const del = await api(
  'DELETE',
  `/api/v1/tenants/${me.personalTenantId}/agents/instances/${me.paInstanceId}`,
  undefined,
  cookies
);
if (del.status !== 204) fail('delete Myra instance', del.status, del.data);

log('Deleted Myra instance and tore down its session.');
log('Reload the web app — /api/v1/me will re-provision and relaunch a fresh Myra.');
