// Package-owned migrations for @corbits/routines' two tables, following
// the same pattern as @corbits/chat's `migrations.ts`: the platform's
// own schema is authored and applied by @intx/db, and this module is
// this package's half of the "mount + migrations is the entire install
// story" install contract. Bookkeeping is its own ledger table, never
// the platform's drizzle journal, so this package's migration history
// stays extractable on its own.
import postgres from "postgres";

import { computeNextFireAt, type RoutineTriggerT } from "./trigger";

type PostgresSql = ReturnType<typeof postgres>;

export interface RoutineMigration {
  name: string;
  sql: string;
  /**
   * An optional JS-driven follow-up, run immediately after `sql` inside
   * the same migration step — for work `sql` alone can't do, like
   * backfilling a computed column from data already in the table. Kept
   * separate from `sql` (rather than folding everything into one big
   * function) so every migration's schema change stays a plain,
   * reviewable SQL string; only the ones that need computed backfill
   * carry one.
   */
  backfill?: (sql: PostgresSql) => Promise<void>;
}

export const routineMigrations: readonly RoutineMigration[] = [
  {
    name: "0001_routine",
    sql: `
      CREATE TABLE IF NOT EXISTS "routine" (
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
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: "0002_routine_run",
    sql: `
      CREATE TABLE IF NOT EXISTS "routine_run" (
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
    name: "0003_routine_next_fire_at",
    sql: `
      ALTER TABLE "routine" ADD COLUMN IF NOT EXISTS "next_fire_at" timestamptz;
      ALTER TABLE "routine" ADD COLUMN IF NOT EXISTS "last_fire_at" timestamptz;
      CREATE INDEX IF NOT EXISTS "routine_next_fire_at_idx" ON "routine" ("next_fire_at") WHERE "enabled" AND "next_fire_at" IS NOT NULL;
    `,
    // The new column starts NULL for every pre-existing row, and
    // `listDueRoutines`'s `nextFireAt <= now` treats NULL as "never
    // due" — without this backfill, every routine that existed before
    // this migration would stop firing forever, silently, the moment
    // it deploys. Every enabled, timer-triggered routine gets a fresh
    // `nextFireAt` computed from its own trigger, exactly the same way
    // `createRoutine` computes one for a brand new row.
    //
    // No `deleted_at IS NULL` filter here: this migration runs before
    // 0004_routine_soft_delete adds that column, so at this point in
    // the sequence every row is, by definition, not soft-deleted — the
    // predicate would be vacuously true if it existed, and referencing
    // a column that doesn't exist yet aborts a from-scratch migration
    // run outright.
    async backfill(sql) {
      const rows = await sql<{ id: string; trigger: RoutineTriggerT }[]>`
        SELECT "id", "trigger" FROM "routine"
        WHERE "enabled" = true
          AND "trigger" IS NOT NULL
          AND "next_fire_at" IS NULL
      `;
      const now = new Date();
      for (const row of rows) {
        const nextFireAt = computeNextFireAt(row.trigger, now);
        await sql`
          UPDATE "routine" SET "next_fire_at" = ${nextFireAt} WHERE "id" = ${row.id}
        `;
      }
    },
  },
  {
    name: "0004_routine_soft_delete",
    sql: `
      ALTER TABLE "routine" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
    `,
  },
];

// Named distinctly from the platform's setup ledger and from any
// drizzle journal, so extracting @corbits/routines out of this repo
// never has to disentangle its history from the platform's or from
// @corbits/chat's own `chat_migrations` ledger.
const LEDGER_TABLE = "routine_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const rows = await sql.unsafe(
      `SELECT name FROM ${quoteIdentifier(LEDGER_TABLE)}`,
    );
    const alreadyApplied = new Set(rows.map((row) => String(row["name"])));
    const applied: string[] = [];
    for (const migration of routineMigrations) {
      if (alreadyApplied.has(migration.name)) continue;
      try {
        await sql.unsafe(migration.sql);
        if (migration.backfill !== undefined) {
          await migration.backfill(sql);
        }
        await sql.unsafe(
          `INSERT INTO ${quoteIdentifier(LEDGER_TABLE)} (name) VALUES ($1)`,
          [migration.name],
        );
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
