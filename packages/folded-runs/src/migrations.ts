// Package-owned migrations for @corbits/folded-runs's own product table
// (see ./schema.ts). Mirrors @corbits/chat's migrations.ts exactly: a
// literal, reviewed SQL ledger applied idempotently against
// DATABASE_URL, bookkept in this package's own ledger table rather than
// the platform's drizzle journal, so this package's migration history
// stays extractable on its own.
import postgres from "postgres";

export interface FoldedRunsMigration {
  name: string;
  sql: string;
}

export const foldedRunsMigrations: readonly FoldedRunsMigration[] = [
  {
    name: "0001_folded_run",
    sql: `
      CREATE TABLE IF NOT EXISTS "folded_runs"."folded_run" (
        "id" text NOT NULL,
        "tenant_id" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id")
      );
    `,
  },
];

const SCHEMA = "folded_runs";
const LEDGER_TABLE = "folded_runs_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

// The synthetic ledger entry the one-time backfill records once it
// completes, so a re-run is a no-op — the same ledger table and the
// same "already applied, skip" contract every entry in
// `foldedRunsMigrations` follows, just driven from outside the literal
// SQL list since its input (which ids to backfill) comes from other
// packages' own schemas, not this package's.
const BACKFILL_MIGRATION_NAME = "0002_backfill_existing_folded_runs";

export interface FoldedRunSeed {
  readonly id: string;
  readonly tenantId: string;
}

export interface BackfillFoldedRunMarkersReport {
  readonly applied: boolean;
  readonly inserted: number;
}

/**
 * One-time backfill for every folded run launched before this
 * package's own `folded_run` marker table existed (CL-6061). Those
 * runs are still recorded — just in each launching package's own
 * table (`@corbits/chat`'s `channel_launch`, `@corbits/tasks`' `task`
 * and `task_leg`) — so this package never reads them itself: chat and
 * tasks both depend on `@corbits/folded-runs` already, and reading
 * their schemas from here would close that into a cycle. Instead the
 * caller (scripts/db-setup.ts, the one place that already knows and
 * sequences every installed package's migrations) sources `seeds` from
 * each package's own exported lister
 * (`listChannelLaunchFoldedRunIds`, `listTaskFoldedRunIds`) and this
 * function only ever inserts into its own table. Ledgered under
 * `BACKFILL_MIGRATION_NAME` so a second call — the very next
 * `db-setup` run, or the next deploy — is a no-op rather than
 * re-scanning every installed package's tables forever.
 */
export async function backfillFoldedRunMarkers(
  databaseUrl: string,
  seeds: readonly FoldedRunSeed[],
): Promise<BackfillFoldedRunMarkersReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const already = await sql.unsafe(
      `SELECT 1 FROM ${quoteQualified(SCHEMA, LEDGER_TABLE)} WHERE name = $1`,
      [BACKFILL_MIGRATION_NAME],
    );
    if (already.length > 0) return { applied: false, inserted: 0 };

    let inserted = 0;
    await sql.begin(async (tx) => {
      for (const seed of seeds) {
        const result = await tx.unsafe(
          `INSERT INTO ${quoteQualified(SCHEMA, "folded_run")} ` +
            `("id", "tenant_id") VALUES ($1, $2) ON CONFLICT ("id") DO NOTHING`,
          [seed.id, seed.tenantId],
        );
        inserted += result.count;
      }
      await tx.unsafe(
        `INSERT INTO ${quoteQualified(SCHEMA, LEDGER_TABLE)} (name) VALUES ($1)`,
        [BACKFILL_MIGRATION_NAME],
      );
    });
    return { applied: true, inserted };
  } finally {
    await sql.end();
  }
}

export interface ApplyFoldedRunsMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply `foldedRunsMigrations` against `databaseUrl`, idempotently: a
 * migration already recorded in the ledger is skipped, never re-run.
 * Failures are loud — the migration name and the underlying error are
 * both surfaced, since a partial apply here would otherwise fail
 * silently at the next `workbench setup`.
 */
export async function applyFoldedRunsMigrations(
  databaseUrl: string,
): Promise<ApplyFoldedRunsMigrationsReport> {
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
    for (const migration of foldedRunsMigrations) {
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
          `@corbits/folded-runs migration ${JSON.stringify(migration.name)} failed: ` +
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
