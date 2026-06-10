#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Read-only diagnostic for CL-1635: does a user's principal hold the
 * instance grants needed to operate their personal agent?
 *
 * Bun auto-loads `.env` from the current working directory, so run this from
 * the repo root (or any dir whose `.env` defines DATABASE_URL).
 *
 * Env / args (args override env):
 *   DATABASE_URL — Postgres connection string (required)
 *   REF_ID       — the user's auth user id (the `userId` from /api/v1/me)
 *   TENANT_ID    — the working tenant id (the `personalTenantId` from /me)
 *   INSTANCE_ID  — the personal agent instance id (the `paInstanceId` from /me)
 *
 * Usage:
 *   bun apps/hub/bin/diagnose-instance-grants.ts
 *   bun apps/hub/bin/diagnose-instance-grants.ts --ref F9lvb2... --tenant tnt_a964... --instance ins_cc9c...
 */

import postgres from 'postgres';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(
      `[diagnose-instance-grants] Missing ${name} (set env or pass the matching --flag)`
    );
    process.exit(1);
  }
  return value;
}

const databaseUrl = required('DATABASE_URL', process.env['DATABASE_URL']);
const refId = required('REF_ID / --ref', arg('--ref') ?? process.env['REF_ID']);
const tenantId = required('TENANT_ID / --tenant', arg('--tenant') ?? process.env['TENANT_ID']);
const instanceId = required(
  'INSTANCE_ID / --instance',
  arg('--instance') ?? process.env['INSTANCE_ID']
);

const sql = postgres(databaseUrl, { max: 1 });

try {
  const [principal] = await sql<{ id: string }[]>`
    select id from principal
    where ref_id = ${refId} and kind = 'user' and tenant_id = ${tenantId}
    limit 1
  `;
  if (!principal) {
    console.error(
      `[diagnose-instance-grants] No user principal for ref_id=${refId} in tenant=${tenantId}. ` +
        `Check the userId/personalTenantId from /api/v1/me.`
    );
    process.exit(1);
  }
  console.log(`Principal: ${principal.id}`);
  console.log(`Instance:  ${instanceId}`);

  const roles = await sql<{ name: string }[]>`
    select r.name from principal_role pr
    join role r on r.id = pr.role_id
    where pr.principal_id = ${principal.id}
  `;
  console.log(`Roles in tenant: ${roles.map((r) => r.name).join(', ') || '(none)'}`);

  const grants = await sql<{ resource: string; action: string; effect: string; origin: string }[]>`
    select resource, action, effect, origin from "grant"
    where principal_id = ${principal.id}
      and resource = ${`instance:${instanceId}`}
    order by action
  `;

  if (grants.length === 0) {
    console.log('');
    console.log(`>> NO instance grants for this principal on instance:${instanceId}.`);
    console.log(
      '>> Confirms CL-1635: the owning member never received instance read/write/manage.'
    );
    console.log(
      '>> (If chat partially works, it is via a role grant or a privileged proxy route, not this instance grant.)'
    );
  } else {
    console.log('');
    console.log(`Instance grants (${grants.length}):`);
    for (const g of grants) {
      console.log(`  ${g.action.padEnd(7)} ${g.effect.padEnd(5)} origin=${g.origin}`);
    }
    const actions = new Set(grants.filter((g) => g.effect === 'allow').map((g) => g.action));
    const missing = ['read', 'write', 'manage'].filter((a) => !actions.has(a));
    console.log('');
    console.log(
      missing.length === 0
        ? '>> All of read/write/manage present.'
        : `>> Missing: ${missing.join(', ')}`
    );
  }
} finally {
  await sql.end();
}
