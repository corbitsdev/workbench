#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Activate all `invited` user principals in a workbench.
 *
 * Repairs members added via the invite flow before auto-activation existed:
 * an `invited` principal fails the workflow access gate (which requires
 * `active`), so those users see "Tenant not accessible" and no workflows.
 *
 * Auth: set SESSION_TOKEN to a better-auth session cookie, or fall back to
 * email/password where that auth mode is enabled.
 *
 * Env:
 *   HUB_URL           — hub base URL (default http://localhost:4000)
 *   SESSION_TOKEN     — better-auth session token (preferred in prod/staging)
 *   SUPERADMIN_EMAIL  — email for password sign-in (default alice@example.com)
 *   SUPERADMIN_PASS   — password for sign-in (default password123)
 *   WORKBENCH_SLUG    — slug of the workbench to repair (e.g. abk-labs); if
 *                       unset, the script lists workbenches and prompts.
 */

import * as readline from 'readline';
import { api, env, makeLogger, makeFail, signIn, type CookieJar } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];
const WORKBENCH_SLUG = process.env['WORKBENCH_SLUG'];

const log = makeLogger('activate-invited-members');
const fail = makeFail('activate-invited-members');

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
};

type PaginatedPrincipals = { data: PrincipalRow[]; nextCursor: string | null };

type WorkbenchPrincipal = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: string;
};

async function listAllPrincipals(tenantId: string, cookies: CookieJar): Promise<PrincipalRow[]> {
  const all: PrincipalRow[] = [];
  let cursor: string | null = null;
  do {
    const qs = `kind=user&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api(BASE, 'GET', `/api/tenants/${tenantId}/principals?${qs}`, undefined, cookies);
    if (res.status !== 200) fail(`list principals for tenant ${tenantId}`, res.status, res.data);
    const page = res.data as PaginatedPrincipals;
    all.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

const meRes = await api(BASE, 'GET', '/api/v1/me', undefined, cookies);
if (meRes.status !== 200) fail('/api/v1/me', meRes.status, meRes.data);
const me = meRes.data as { personalTenantId: string | null };
if (!me.personalTenantId) {
  console.error('[activate-invited-members] No global org tenant found for this user.');
  process.exit(1);
}
const globalTenantId = me.personalTenantId;

const principalsRes = await api(BASE, 'GET', '/api/me/principals', undefined, cookies);
if (principalsRes.status !== 200) fail('list principals', principalsRes.status, principalsRes.data);
const { data: allPrincipals } = principalsRes.data as { data: WorkbenchPrincipal[] };
const workbenches = allPrincipals.filter((p) => p.kind === 'user' && p.tenantId !== globalTenantId);

if (workbenches.length === 0) {
  log('No workbenches found.');
  process.exit(0);
}

let target: WorkbenchPrincipal;
if (WORKBENCH_SLUG) {
  const match = workbenches.find((w) => w.tenantSlug === WORKBENCH_SLUG);
  if (!match) fail(`workbench slug ${WORKBENCH_SLUG}`, 404, 'not found among admin workbenches');
  target = match!;
} else {
  console.log('\nWorkbenches:');
  workbenches.forEach((wb, i) => {
    console.log(`  [${i + 1}] ${wb.tenantName} (${wb.tenantSlug})`);
  });
  const idxStr = await prompt('\nSelect workbench number: ');
  const idx = parseInt(idxStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= workbenches.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  target = workbenches[idx]!;
}

const members = await listAllPrincipals(target.tenantId, cookies);
const invited = members.filter((m) => m.status === 'invited');

if (invited.length === 0) {
  log(`No invited members in ${target.tenantName} — nothing to activate.`);
  process.exit(0);
}

console.log(`\nInvited members in ${target.tenantName}:`);
invited.forEach((m) => console.log(`  - ${m.displayName}${m.email ? ` <${m.email}>` : ''}`));

const confirm = await prompt(`\nActivate all ${invited.length} invited member(s)? [y/N] `);
if (confirm !== 'y' && confirm !== 'yes') {
  log('Aborted.');
  process.exit(0);
}

for (const m of invited) {
  const res = await api(
    BASE,
    'PATCH',
    `/api/tenants/${target.tenantId}/principals/${m.id}`,
    { status: 'active' },
    cookies
  );
  if (res.status !== 200) fail(`activate ${m.id}`, res.status, res.data);
  log(`Activated ${m.displayName}.`);
}

log(`Done. Activated ${invited.length} member(s) in ${target.tenantName}.`);
