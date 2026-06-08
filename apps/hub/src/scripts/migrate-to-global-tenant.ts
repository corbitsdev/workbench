/**
 * One-off data migration: move existing users from their personal tenants into
 * the shared global org tenant (CL-1451).
 *
 * Usage (from repo root, with the hub env loaded):
 *   bun --env-file=.env run apps/hub/src/scripts/migrate-to-global-tenant.ts            # dry run (default)
 *   bun --env-file=.env run apps/hub/src/scripts/migrate-to-global-tenant.ts --live     # perform writes
 *
 * Dry run logs per-user counts and writes nothing — run it and eyeball the
 * output before the live run. The live run migrates each user in its own
 * transaction; one failure is logged and the batch continues. Safe to re-run.
 *
 * The global tenant must already be seeded (it is, on every hub boot — CL-1446).
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getLogger } from '@intx/log';
import { loadConfig } from '../config';
import { resolveDatabaseConfig } from '../lib/db';
import { schema, type HubDb } from '../db';
import { migrateAllUsersToGlobalTenant } from '../lib/migrate-to-global-tenant';

const log = getLogger(['migrate', 'cli']);

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const dryRun = !live;

  // loadConfig validates the env (incl. GLOBAL_TENANT_*) and fails loud if missing.
  loadConfig();

  const dbConfig = resolveDatabaseConfig();
  const sql = postgres({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    max: 1,
    ...(dbConfig.ssl !== undefined && { ssl: dbConfig.ssl }),
  });
  const db = drizzle(sql, { schema }) as unknown as HubDb;

  try {
    log.info(dryRun ? 'Starting migration DRY RUN (no writes)' : 'Starting LIVE migration');
    const summary = await migrateAllUsersToGlobalTenant(db, { dryRun });

    for (const u of summary.users) {
      log.info('user', {
        userId: u.userId,
        workbenchesReparented: u.workbenchesReparented,
        workflowRunsReKeyed: u.workflowRunsReKeyed,
        artifactsReKeyed: u.artifactsReKeyed,
        artifactVersionsReKeyed: u.artifactVersionsReKeyed,
        oldMyraInstancesStopped: u.oldMyraInstancesStopped,
      });
    }
    log.info('Summary', {
      dryRun: summary.dryRun,
      globalTenantId: summary.globalTenantId,
      migrated: summary.users.length,
      failures: summary.failures.length,
    });
    if (summary.failures.length > 0) {
      log.error('Some users failed to migrate', {
        failures: summary.failures,
        error: new Error(`${summary.failures.length} user(s) failed`),
      });
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

await main();
