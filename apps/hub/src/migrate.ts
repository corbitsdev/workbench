// Boot-time migrations for the hub, run once before `createHubServer`
// mounts anything. Interchange's own platform schema is authored and
// applied by `@intx/db`'s `runMigrations`; every mounted Corbits
// library that owns its own product tables applies its own single,
// idempotent migration right after, exactly the way upstream
// Interchange applies its schema — no separate migration-runner
// service, no ledger table, just the hub doing the work itself.
import { runMigrations } from "@intx/db";
import { sql } from "drizzle-orm";
import { applyCronMigrations } from "@corbits/cron";
import { createMailboxDb, runMailboxMigrations } from "@corbits/mailbox";
import { runArtifactMigrations } from "@corbits/artifacts";
import { runMemoryMigrations } from "@corbits/memory";

export interface HubMigrateConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
}

async function platformSchemaPresent(
  db: Parameters<typeof runArtifactMigrations>[0],
  schema: string,
): Promise<boolean> {
  const rows = await db.execute<{ present: string | null }>(
    sql`select to_regclass(${`"${schema}"."user"`}) as present`,
  );
  return rows[0]?.present != null;
}

function databaseUrlFrom(config: HubMigrateConfig): string {
  return (
    `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}` +
    `@${config.host}:${String(config.port)}/${config.database}`
  );
}

/**
 * Apply the platform schema plus every mounted Corbits package's own
 * migration, in the order the hub mounts them: cron, mailbox, artifacts,
 * memory. `@corbits/webhooks` owns no table of its own, so it has no
 * migration step. `db` is the same drizzle handle the rest
 * of the hub uses, so `runArtifactMigrations` (which takes a drizzle
 * db, not a URL) shares the one connection pool rather than opening
 * its own.
 */
export async function migrateHub(
  config: HubMigrateConfig,
  db: Parameters<typeof runArtifactMigrations>[0],
): Promise<void> {
  const databaseUrl = databaseUrlFrom(config);
  const schema = config.schema ?? "public";

  // Upstream's platform SQL is one-shot (no ledger, no IF NOT EXISTS),
  // so it runs only on a database that has no platform tables yet.
  if (!(await platformSchemaPresent(db, schema))) {
    await runMigrations(config, { schema });
  }
  await applyCronMigrations(databaseUrl, { tenantSchema: schema });

  const mailboxDb = createMailboxDb(databaseUrl);
  try {
    await runMailboxMigrations(mailboxDb.db);
  } finally {
    await mailboxDb.close();
  }

  await runArtifactMigrations(db);
  await runMemoryMigrations(databaseUrl);
}
