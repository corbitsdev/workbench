// Package-owned migration for @corbits/webhook-triggers's product
// tables. The platform's own schema is authored and applied by
// @intx/db (see apps/hub/src/migrate.ts); this module is the
// package's half of the install story — mount + migration is the
// entire install story, mirroring `@corbits/cron`'s `schema.ts`.
//
// One idempotent SQL block, `CREATE SCHEMA IF NOT EXISTS` plus
// `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`
// throughout, so no ledger table is needed to know what has run. A
// session-level advisory lock (`pg_advisory_xact_lock`, released
// automatically at transaction end) held around the whole statement
// block keeps two hub replicas booting at once from racing each
// other's DDL.
import postgres from "postgres";

export const webhookTriggersMigrationSql = `
  CREATE SCHEMA IF NOT EXISTS "webhook_triggers";

  CREATE TABLE IF NOT EXISTS "webhook_triggers"."webhook_trigger" (
    "id" text PRIMARY KEY,
    "tenant_id" text NOT NULL REFERENCES "public"."tenant" ("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "workflow_definition_id" text NOT NULL,
    "input_template" text NOT NULL,
    "secret" text NOT NULL,
    "enabled" boolean NOT NULL DEFAULT true,
    "created_by" text NOT NULL REFERENCES "public"."principal" ("id") ON DELETE CASCADE,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "last_fired_at" timestamptz
  );

  CREATE INDEX IF NOT EXISTS "webhook_trigger_tenant_id_idx"
    ON "webhook_triggers"."webhook_trigger" ("tenant_id");

  CREATE UNIQUE INDEX IF NOT EXISTS "webhook_trigger_tenant_definition_name_unique"
    ON "webhook_triggers"."webhook_trigger" ("tenant_id", "workflow_definition_id", "name");
`;

/**
 * Apply `webhookTriggersMigrationSql` against `databaseUrl`, idempotently
 * (every statement is `IF NOT EXISTS`) and inside one advisory-locked
 * transaction so concurrent hub replicas cannot race the same DDL.
 */
export async function applyWebhookTriggersMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('corbits_webhook_triggers'))`);
      await tx.unsafe(webhookTriggersMigrationSql);
    });
  } catch (error) {
    throw new Error(
      `@corbits/webhook-triggers migration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
