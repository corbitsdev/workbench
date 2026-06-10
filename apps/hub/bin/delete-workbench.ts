#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Delete a workbench tenant and everything scoped to it.
 *
 * There is no HTTP endpoint for this — it is a destructive owner-only DB op.
 * Most Interchange tables (principal, role, grant, agent, agent_instance,
 * credential, provider, session, message, ...) reference `tenant.id` with
 * ON DELETE CASCADE, so dropping the tenant row removes them. The workbench-side
 * tables (apps/hub/src/db/schema.ts) use a plain `tenant_id` text column with NO
 * FK, so they would be orphaned — this script deletes those explicitly first.
 *
 * Bun auto-loads `.env` from the working directory, so run from the repo root.
 *
 * Safety:
 *   - Refuses to delete a ROOT tenant (parent_id IS NULL) — that is the global
 *     org tenant / Interchange personal tenants, never a workbench.
 *   - Dry-run by default: prints the tenant and row counts. Pass --yes to execute.
 *
 * Env / args (args override env):
 *   DATABASE_URL — Postgres connection string (required)
 *   --tenant     — tenant id (tnt_...)        ┐ provide one
 *   --slug       — tenant slug                ┘ of these
 *   --yes        — actually delete (otherwise dry-run)
 *
 * Usage:
 *   bun apps/hub/bin/delete-workbench.ts --slug sawyer-test
 *   bun apps/hub/bin/delete-workbench.ts --tenant tnt_3298be5ab78d7cf1ef14d900975fae66 --yes
 */

import postgres from 'postgres';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`[delete-workbench] Missing ${name}`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = required('DATABASE_URL', process.env['DATABASE_URL']);
const tenantArg = arg('--tenant');
const slugArg = arg('--slug');
const execute = process.argv.includes('--yes');

if (!tenantArg && !slugArg) {
  console.error('[delete-workbench] Provide --tenant <id> or --slug <slug>');
  process.exit(1);
}

// Workbench-owned tables keyed by a plain tenant_id (no FK cascade), in
// dependency order. workflow_run cascades to pain_point and to artifacts via
// session_id; artifact cascades to artifact_version. Deleting workflow_run
// first clears session-linked rows, then we sweep anything left by tenant_id.
const TENANT_SCOPED_TABLES = [
  'workflow_run',
  'artifact',
  'workbench_workflows',
  'member_agent_instance',
  'approval',
] as const;

const sql = postgres(databaseUrl, { max: 1 });

try {
  const [tenant] = await sql<
    { id: string; name: string; slug: string; parent_id: string | null }[]
  >`
    select id, name, slug, parent_id from tenant
    where ${tenantArg ? sql`id = ${tenantArg}` : sql`slug = ${slugArg}`}
    limit 1
  `;

  if (!tenant) {
    console.error(`[delete-workbench] No tenant found for ${tenantArg ?? slugArg}`);
    process.exit(1);
  }
  if (tenant.parent_id === null) {
    console.error(
      `[delete-workbench] Refusing: ${tenant.id} (${tenant.slug}) is a ROOT tenant (parent_id is null) — not a workbench.`
    );
    process.exit(1);
  }

  console.log(`[delete-workbench] Tenant: ${tenant.name} (slug=${tenant.slug}, id=${tenant.id})`);

  for (const table of TENANT_SCOPED_TABLES) {
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from ${sql(table)} where tenant_id = ${tenant.id}
    `;
    console.log(`[delete-workbench]   ${table}: ${count}`);
  }

  if (!execute) {
    console.log('[delete-workbench] DRY RUN — pass --yes to delete the tenant and the rows above.');
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    for (const table of TENANT_SCOPED_TABLES) {
      await tx`delete from ${tx(table)} where tenant_id = ${tenant.id}`;
    }
    await tx`delete from tenant where id = ${tenant.id}`;
  });

  console.log(`[delete-workbench] Deleted workbench ${tenant.slug} (${tenant.id}).`);
} finally {
  await sql.end();
}
