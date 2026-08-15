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
