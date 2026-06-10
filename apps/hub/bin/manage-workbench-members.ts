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
import { api, env, makeLogger, makeFail, signIn, type CookieJar } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

const log = makeLogger('manage-workbench-members');
const fail = makeFail('manage-workbench-members');

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
    const res = await api(
      BASE,
      'GET',
      `/api/tenants/${tenantId}/principals?${qs}`,
      undefined,
      cookies
    );
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

async function activatePrincipal(
  tenantId: string,
  principalId: string,
  cookies: CookieJar
): Promise<void> {
  const res = await api(
    BASE,
    'PATCH',
    `/api/tenants/${tenantId}/principals/${principalId}`,
    { status: 'active' },
    cookies
  );
  if (res.status !== 200) fail(`activate principal ${principalId}`, res.status, res.data);
}

const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

// Get the global org tenant ID from /me
const meRes = await api(BASE, 'GET', '/api/v1/me', undefined, cookies);
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

// List workbenches (authenticated admin's principals, excluding global tenant)
const principalsRes = await api(BASE, 'GET', '/api/me/principals', undefined, cookies);
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
    return {
      wb,
      isMember: !!existing,
      principalId: existing?.id ?? null,
      status: existing?.status ?? null,
      index: i,
    };
  })
);

membershipChecks.forEach(({ wb, isMember, status, index }) => {
  const label = isMember ? `MEMBER (${status})` : 'not a member';
  console.log(`  [${index + 1}] ${wb.tenantName} (${wb.tenantSlug}) — ${label}`);
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
  // An existing principal is created by invite in `invited` state; the workflow
  // access gate only accepts `active`. Activate directly rather than re-inviting
  // (the invite endpoint 409s on an existing principal).
  if (selected.isMember) {
    if (selected.status === 'active') {
      log(`${selectedUser.displayName} is already an active member of ${selected.wb.tenantName}.`);
      process.exit(0);
    }
    if (!selected.principalId) fail('activate existing member', 0, 'missing principal id');
    await activatePrincipal(selected.wb.tenantId, selected.principalId!, cookies);
    log(
      `Activated ${selectedUser.displayName} in ${selected.wb.tenantName} (was ${selected.status}).`
    );
    process.exit(0);
  }
  if (!selectedUser.email) {
    console.error('[manage-workbench-members] Cannot invite user: no email address available.');
    process.exit(1);
  }
  const inviteRes = await api(
    BASE,
    'POST',
    `/api/tenants/${selected.wb.tenantId}/members/invite`,
    { email: selectedUser.email },
    cookies
  );
  if (inviteRes.status !== 200 && inviteRes.status !== 201) {
    fail(`invite ${selectedUser.email}`, inviteRes.status, inviteRes.data);
  }
  const invited = inviteRes.data as { id: string };
  await activatePrincipal(selected.wb.tenantId, invited.id, cookies);
  log(`Added and activated ${selectedUser.displayName} in ${selected.wb.tenantName}.`);
} else if (action === 'r' || action === 'remove') {
  if (!selected.isMember || !selected.principalId) {
    log(`${selectedUser.displayName} is not a member of ${selected.wb.tenantName}.`);
    process.exit(0);
  }
  const deleteRes = await api(
    BASE,
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
