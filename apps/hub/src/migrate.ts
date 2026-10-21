// Boot-time migrations for the hub, run once before `createHubServer`
// mounts anything. Interchange's own platform schema is authored and
// applied by `@intx/db`'s `runMigrations`; every mounted Corbits
// library that owns its own product tables applies its own single,
// idempotent migration right after, exactly the way upstream
// Interchange applies its schema — no separate migration-runner
// service, no ledger table, just the hub doing the work itself.
import { runMigrations, type createDB, type DBConfig } from "@intx/db";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { runAgentTokenMigrations } from "@corbits/agent-token/migrations";
import { runCronMigrations } from "@corbits/cron/migrations";
import { runMailboxMigrations } from "@corbits/mailbox";
import { runArtifactMigrations } from "@corbits/artifacts";
import { runMemoryMigrations } from "@corbits/memory/migrations";
import { runWebhookMigrations } from "@corbits/webhooks/migrations";

export type HubMigrateConfig = DBConfig & {
  schema?: string;
};

type HubDatabase = ReturnType<typeof createDB>["db"];

async function platformSchemaPresent(db: HubDatabase, schema: string): Promise<boolean> {
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
 * migration, in the order the hub mounts them: cron, agent tokens, mailbox,
 * artifacts, memory, webhooks.
 */
export async function migrateHub(config: HubMigrateConfig, db: HubDatabase): Promise<void> {
  // Concurrent boots serialize on a session-level advisory lock held by a
  // dedicated connection. No transaction stays open, so a single-backend
  // database like PGlite still serves the migrations' other connections.
  const lockClient = postgres(databaseUrlFrom(config), { max: 1 });
  try {
    await lockClient`select pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
    try {
      await applyMigrations(config, db);
    } finally {
      await lockClient`select pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
    }
  } finally {
    await lockClient.end();
  }
}

const MIGRATE_LOCK_KEY = 7_460_391_205;

async function applyMigrations(config: HubMigrateConfig, db: HubDatabase): Promise<void> {
  const schema = config.schema ?? "public";
  const ftsLanguageRaw = process.env["FTS_LANGUAGE"];
  const ftsLanguage =
    ftsLanguageRaw !== undefined && ftsLanguageRaw.trim() !== ""
      ? ftsLanguageRaw.trim()
      : "english";

  // Upstream's platform SQL is one-shot (no ledger, no IF NOT EXISTS),
  // so it runs only on a database that has no platform tables yet.
  if (!(await platformSchemaPresent(db, schema))) {
    await runMigrations(config, { schema });
  }
  await runCronMigrations(config, { schema });
  await runAgentTokenMigrations(config, { schema });
  await runMailboxMigrations(config, { schema });
  await runArtifactMigrations(config, { schema });
  await runMemoryMigrations(config, { schema, ftsLanguage });
  await runWebhookMigrations(config, { schema });
}
