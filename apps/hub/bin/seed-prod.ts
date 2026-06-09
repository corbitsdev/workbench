#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * GTM Workbench production seed script.
 *
 * Use this when email/password auth is disabled (i.e. production).
 * Sign in via Google OAuth on the web app first — that triggers provisioning.
 * Then run this script to promote your user to the Interchange `owner` role
 * so admin-ui works.
 *
 * Required env vars:
 *   DATABASE_URL       — Postgres connection string
 *   SUPERADMIN_EMAIL   — email of the user to promote (looked up in the DB)
 *
 * For local dev, run seed.ts instead.
 */

import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[seed-prod] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[seed-prod] ${message}`);
}

const email = requireEnv('SUPERADMIN_EMAIL');
const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  log(`Looking up user: ${email}`);

  const [user] = await sql<{ id: string }[]>`
    select id from "user"
    where email = ${email}
    limit 1
  `;
  if (!user) {
    console.error(`[seed-prod] No user found with email ${email}. Sign in via OAuth first.`);
    process.exit(1);
  }
  log(`  User ID: ${user.id}`);

  // Find their global (personal) tenant — the one they own directly.
  const [principal] = await sql<{ id: string; tenant_id: string }[]>`
    select p.id, p.tenant_id
    from principal p
    join tenant t on t.id = p.tenant_id
    where p.kind = 'user'
      and p.ref_id = ${user.id}
      and t.parent_id is null
    limit 1
  `;
  if (!principal) {
    console.error('[seed-prod] Could not find global user principal. Has the user signed in yet?');
    process.exit(1);
  }
  log(`  Principal ID: ${principal.id}`);
  log(`  Tenant ID: ${principal.tenant_id}`);

  const [ownerRole] = await sql<{ id: string }[]>`
    select id from role
    where tenant_id = ${principal.tenant_id}
      and name = 'owner'
    limit 1
  `;
  if (!ownerRole) {
    console.error('[seed-prod] Could not find owner role on tenant.');
    process.exit(1);
  }

  await sql`
    insert into principal_role (principal_id, role_id, created_at)
    values (${principal.id}, ${ownerRole.id}, now())
    on conflict do nothing
  `;
  log(`  Granted owner role ${ownerRole.id} to principal ${principal.id}`);
} finally {
  await sql.end();
}

log('Done.');
