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

import { api, env, makeLogger, makeFail, signIn } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

const log = makeLogger('create-workbench');
const fail = makeFail('create-workbench');

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

const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

// Create workbench
const createRes = await api(BASE, 'POST', '/api/v1/workbenches', { name }, cookies);
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
    BASE,
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
