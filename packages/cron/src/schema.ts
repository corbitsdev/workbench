// The `cron` schema's one table: a tenant's saved cron schedules. Kept on
// its own Postgres schema, with a real FK back to Interchange's `tenant`
// table, per this repo's "custom tables live on their own schema" rule.
import { pgTable, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });

export const cronSchema = pgSchema("cron");

export const cronScheduleTable = cronSchema.table("schedule", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => hostTenant.id, { onDelete: "cascade" }),
  expression: text("expression").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const LEDGER_TABLE = "cron_migrations";

export interface CronMigration {
  name: string;
  sql: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Migration list building the FK against `tenantSchema.tenant` —
 * `"public"` in every real deployment; a test harness that runs the
 * platform migrations into a scratch schema passes that schema instead so
 * the FK targets its own `tenant` row, not the real one.
 */
function buildCronMigrations(tenantSchema: string): readonly CronMigration[] {
  const tenantTable = `${quoteIdentifier(tenantSchema)}."tenant"`;
  return [
    {
      name: "0001_schedule",
      sql: `
        CREATE SCHEMA IF NOT EXISTS "cron";
        CREATE TABLE IF NOT EXISTS "cron"."schedule" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL REFERENCES ${tenantTable}("id") ON DELETE CASCADE,
          "expression" text NOT NULL,
          "to_address" text NOT NULL,
          "subject" text NOT NULL,
          "body" text NOT NULL,
          "last_fired_at" timestamptz,
          "created_at" timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "cron_schedule_tenant_id_idx" ON "cron"."schedule" ("tenant_id");
      `,
    },
  ];
}

export const cronMigrations: readonly CronMigration[] = buildCronMigrations("public");

export interface ApplyCronMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply `cronMigrations` against `databaseUrl`, idempotently: a migration
 * already recorded in this package's own ledger is skipped, never re-run.
 * Mirrors `@corbits/inbox`'s `applyInboxMigrations` shape.
 */
export async function applyCronMigrations(
  databaseUrl: string,
  options?: { tenantSchema?: string },
): Promise<ApplyCronMigrationsReport> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "cron"`);
    await client.unsafe(
      `CREATE TABLE IF NOT EXISTS "cron"."${LEDGER_TABLE}" (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    const migrations = buildCronMigrations(options?.tenantSchema ?? "public");

    for (const migration of migrations) {
      const existing = await client.unsafe(
        `SELECT 1 FROM "cron"."${LEDGER_TABLE}" WHERE name = $1`,
        [migration.name],
      );
      if (existing.length > 0) {
        alreadyApplied.push(migration.name);
        continue;
      }
      try {
        await client.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(`INSERT INTO "cron"."${LEDGER_TABLE}" (name) VALUES ($1)`, [
            migration.name,
          ]);
        });
        applied.push(migration.name);
      } catch (error) {
        throw new Error(
          `@corbits/cron migration ${JSON.stringify(migration.name)} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await client.end({ timeout: 5 });
  }
}
