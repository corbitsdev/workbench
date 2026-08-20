// Package-owned migrations for @corbits/routines' two tables, following
// the same pattern as @corbits/chat's `migrations.ts`: the platform's
// own schema is authored and applied by @intx/db, and this module is
// this package's half of the "mount + migrations is the entire install
// story" install contract. Bookkeeping is its own ledger table, never
// the platform's drizzle journal, so this package's migration history
// stays extractable on its own.
import postgres from "postgres";

export interface RoutineMigration {
  name: string;
  sql: string;
}

export const routineMigrations: readonly RoutineMigration[] = [
  {
    name: "0001_routine",
    sql: `
      CREATE TABLE IF NOT EXISTS "routines"."routine" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "definition_id" text NOT NULL,
        "trigger" jsonb,
        "scope" text NOT NULL,
        "input" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "delivery_channel_id" text,
        "created_by" text NOT NULL,
        "next_fire_at" timestamptz,
        "last_fire_at" timestamptz,
        "deleted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "routine_next_fire_at_idx" ON "routines"."routine" ("next_fire_at") WHERE "enabled" AND "next_fire_at" IS NOT NULL;

      CREATE TABLE IF NOT EXISTS "routines"."routine_run" (
        "tenant_id" text NOT NULL,
        "routine_id" text NOT NULL,
        "run_id" text NOT NULL,
        "triggered_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "run_id")
      );
    `,
  },
  {
    name: "0002_failure_tracking",
    sql: `
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamptz;
      ALTER TABLE "routines"."routine_run"
        ADD COLUMN IF NOT EXISTS "error" text;
    `,
  },
  {
    name: "0003_routine_draft",
    sql: `
      CREATE TABLE IF NOT EXISTS "routines"."routine_draft" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "prompt" text NOT NULL,
        "status" text NOT NULL,
        "proposed_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "proposed_trigger" jsonb,
        "proposed_name" text,
        "definition_id" text,
        "delivery_channel_id" text NOT NULL,
        "scope" text NOT NULL,
        "autonomy" jsonb,
        "created_by" text NOT NULL,
        "approved_routine_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "routine_draft_tenant_idx"
        ON "routines"."routine_draft" ("tenant_id", "status");
    `,
  },
  // Product rename (CL-6260): follows @corbits/chat's own
  // 0018_rename_channel_to_workbench — a routine's delivery target is
  // the same workbench, so the column that names it is renamed the
  // same way.
  {
    name: "0004_rename_delivery_channel_id_to_delivery_workbench_id",
    sql: `
      ALTER TABLE "routines"."routine" RENAME COLUMN "delivery_channel_id" TO "delivery_workbench_id";
      ALTER TABLE "routines"."routine_draft" RENAME COLUMN "delivery_channel_id" TO "delivery_workbench_id";
    `,
  },
];

// Named distinctly from the platform's setup ledger and from any
// drizzle journal, so extracting @corbits/routines out of this repo
// never has to disentangle its history from the platform's or from
// @corbits/chat's own `chat_migrations` ledger. Lives in the package's
// own `routines` schema, like every other table it owns.
const SCHEMA = "routines";
const LEDGER_TABLE = "routine_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyRoutineMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply `routineMigrations` against `databaseUrl`, idempotently: a
 * migration already recorded in the ledger is skipped, never re-run.
 * Failures are loud — the migration name and the underlying error are
 * both surfaced.
 */
export async function applyRoutineMigrations(
  databaseUrl: string,
): Promise<ApplyRoutineMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const rows = await sql.unsafe(
      `SELECT name FROM ${quoteQualified(SCHEMA, LEDGER_TABLE)}`,
    );
    const alreadyApplied = new Set(rows.map((row) => String(row["name"])));
    const applied: string[] = [];
    for (const migration of routineMigrations) {
      if (alreadyApplied.has(migration.name)) continue;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO ${quoteQualified(SCHEMA, LEDGER_TABLE)} (name) VALUES ($1)`,
            [migration.name],
          );
        });
        applied.push(migration.name);
      } catch (error) {
        throw new Error(
          `@corbits/routines migration ${JSON.stringify(migration.name)} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    return { applied, alreadyApplied: [...alreadyApplied] };
  } finally {
    await sql.end();
  }
}
