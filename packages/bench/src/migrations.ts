// Package-owned migrations for @corbits/bench. Bookkeeping uses its own
// ledger table so the package can be extracted without disentangling
// history from the platform drizzle journal. Every table this package
// owns — including its ledger — lives in its own `bench` Postgres
// schema, never `public`; see docs/package-migrations.md.
import postgres from "postgres";

export interface BenchMigration {
  name: string;
  sql: string;
}

const SCHEMA = "bench";

export const benchMigrations: readonly BenchMigration[] = [
  {
    name: "0001_bench_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS "bench"."bench_settings" (
        "tenant_id" text PRIMARY KEY,
        "purpose" text,
        "type" text,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

const LEDGER_TABLE = "bench_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyBenchMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyBenchMigrations(
  databaseUrl: string,
): Promise<ApplyBenchMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of benchMigrations) {
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
          `bench migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
