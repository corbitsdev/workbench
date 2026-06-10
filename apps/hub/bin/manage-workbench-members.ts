#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Manage workbench membership for a user.
 *
 * Lists users in the global org tenant, shows their workbench assignments,
 * and prompts to add or remove a user from a workbench.
 *
 * Note: workbenches are listed from the authenticated admin's own principals.
 * A workbench the admin is not a member of will not appear in the list.
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

import * as readline from 'readline';

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
  console.log(`[manage-workbench-members] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[manage-workbench-members] FAIL ${label}: ${status}`);
  console.error(`[manage-workbench-members]   ${JSON.stringify(data)}`);
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

type PrincipalRow = {
  id: string;
  refId: string;
  displayName: string;
  email?: string;
  status: string;
  roles: { id: string; name: string }[];
};

type PaginatedPrincipals = {
  data: PrincipalRow[];
  nextCursor: string | null;
};

async function listAllPrincipals(tenantId: string, cookies: CookieJar): Promise<PrincipalRow[]> {
  const all: PrincipalRow[] = [];
  let cursor: string | null = null;
  do {
    const qs = `kind=user&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api('GET', `/api/tenants/${tenantId}/principals?${qs}`, undefined, cookies);
    if (res.status !== 200) fail(`list principals for tenant ${tenantId}`, res.status, res.data);
    const page = res.data as PaginatedPrincipals;
    all.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

type WorkbenchPrincipal = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: string;
};

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

// Get the global org tenant ID from /me
const meRes = await api('GET', '/api/v1/me', undefined, cookies);
if (meRes.status !== 200) fail('/api/v1/me', meRes.status, meRes.data);
const me = meRes.data as { personalTenantId: string | null };
if (!me.personalTenantId) {
  console.error('[manage-workbench-members] No global org tenant found for this user.');
  process.exit(1);
}
const globalTenantId = me.personalTenantId;

// List users in the global org tenant
const globalUsers = await listAllPrincipals(globalTenantId, cookies);

if (globalUsers.length === 0) {
  log('No users found in the global org tenant.');
  process.exit(0);
}

// List workbenches (user's principals, excluding global tenant)
const principalsRes = await api('GET', '/api/me/principals', undefined, cookies);
if (principalsRes.status !== 200) fail('list principals', principalsRes.status, principalsRes.data);
const { data: allPrincipals } = principalsRes.data as { data: WorkbenchPrincipal[] };
const workbenches = allPrincipals.filter((p) => p.kind === 'user' && p.tenantId !== globalTenantId);

if (workbenches.length === 0) {
  log('No workbenches found. Create one first with create-workbench.ts.');
  process.exit(0);
}

// Display users
console.log('\nUsers in global org:');
globalUsers.forEach((u, i) => {
  console.log(`  [${i + 1}] ${u.displayName}${u.email ? ` <${u.email}>` : ''} (${u.status})`);
});

const userIdxStr = await prompt('\nSelect user number: ');
const userIdx = parseInt(userIdxStr, 10) - 1;
if (isNaN(userIdx) || userIdx < 0 || userIdx >= globalUsers.length) {
  console.error('Invalid selection.');
  process.exit(1);
}
const selectedUser = globalUsers[userIdx]!;
log(`Selected: ${selectedUser.displayName}${selectedUser.email ? ` <${selectedUser.email}>` : ''}`);

// Display workbenches with membership status
console.log('\nWorkbenches:');
const membershipChecks = await Promise.all(
  workbenches.map(async (wb, i) => {
    const members = await listAllPrincipals(wb.tenantId, cookies).catch(() => null);
    if (!members) return { wb, isMember: false, principalId: null, index: i };
    const existing = members.find((m) => m.refId === selectedUser.refId);
    return { wb, isMember: !!existing, principalId: existing?.id ?? null, index: i };
  })
);

membershipChecks.forEach(({ wb, isMember, index }) => {
  console.log(
    `  [${index + 1}] ${wb.tenantName} (${wb.tenantSlug}) — ${isMember ? 'MEMBER' : 'not a member'}`
  );
});

const wbIdxStr = await prompt('\nSelect workbench number: ');
const wbIdx = parseInt(wbIdxStr, 10) - 1;
if (isNaN(wbIdx) || wbIdx < 0 || wbIdx >= membershipChecks.length) {
  console.error('Invalid selection.');
  process.exit(1);
}
const selected = membershipChecks[wbIdx]!;

const action = await prompt(
  `\nAction — [a]dd or [r]emove ${selectedUser.displayName} from ${selected.wb.tenantName}? `
);

if (action === 'a' || action === 'add') {
  if (selected.isMember) {
    log(`${selectedUser.displayName} is already a member of ${selected.wb.tenantName}.`);
    process.exit(0);
  }
  if (!selectedUser.email) {
    console.error('[manage-workbench-members] Cannot invite user: no email address available.');
    process.exit(1);
  }
  const inviteRes = await api(
    'POST',
    `/api/tenants/${selected.wb.tenantId}/members/invite`,
    { email: selectedUser.email },
    cookies
  );
  if (inviteRes.status !== 200 && inviteRes.status !== 201) {
    fail(`invite ${selectedUser.email}`, inviteRes.status, inviteRes.data);
  }
  log(`Added ${selectedUser.displayName} to ${selected.wb.tenantName}.`);
} else if (action === 'r' || action === 'remove') {
  if (!selected.isMember || !selected.principalId) {
    log(`${selectedUser.displayName} is not a member of ${selected.wb.tenantName}.`);
    process.exit(0);
  }
  const deleteRes = await api(
    'DELETE',
    `/api/tenants/${selected.wb.tenantId}/principals/${selected.principalId}`,
    undefined,
    cookies
  );
  if (deleteRes.status !== 204) {
    fail(`remove principal ${selected.principalId}`, deleteRes.status, deleteRes.data);
  }
  log(`Removed ${selectedUser.displayName} from ${selected.wb.tenantName}.`);
} else {
  console.error('Unknown action. Enter "a" to add or "r" to remove.');
  process.exit(1);
}
