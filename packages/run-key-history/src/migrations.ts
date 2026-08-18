// Package-owned migrations for @corbits/run-key-history. Bookkeeping
// uses its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. The table
// this package owns lives in its own `run_key_history` Postgres
// schema, never `public`; see docs/package-migrations.md.
import postgres from "postgres";

export interface RunKeyHistoryMigration {
  name: string;
  sql: string;
}

const SCHEMA = "run_key_history";

export const runKeyHistoryMigrations: readonly RunKeyHistoryMigration[] = [
  {
    name: "0001_run_key_history",
    sql: `
      CREATE TABLE IF NOT EXISTS "run_key_history"."run_key_history" (
        "id" text PRIMARY KEY,
        "run_address" text NOT NULL,
        "public_key" text NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now(),
        "superseded_at" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "run_key_history_run_address_idx"
        ON "run_key_history"."run_key_history" ("run_address");
      CREATE INDEX IF NOT EXISTS "run_key_history_current_idx"
        ON "run_key_history"."run_key_history" ("run_address", "superseded_at");
    `,
  },
];

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

const LEDGER_TABLE = "run_key_history_migrations";

export interface ApplyRunKeyHistoryMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyRunKeyHistoryMigrations(
  databaseUrl: string,
): Promise<ApplyRunKeyHistoryMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of runKeyHistoryMigrations) {
      const existing = await sql.unsafe(
        `SELECT 1 FROM ${quoteQualified(SCHEMA, LEDGER_TABLE)} WHERE name = $1`,
        [migration.name],
      );
      if (existing.length > 0) {
        alreadyApplied.push(migration.name);
        continue;
      }
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO ${quoteQualified(SCHEMA, LEDGER_TABLE)} (name) VALUES ($1)`,
            [migration.name],
          );
        });
        applied.push(migration.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `run_key_history migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
