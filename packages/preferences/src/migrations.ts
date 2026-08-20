// Package-owned migrations for @corbits/preferences. Bookkeeping uses its
// own ledger table so the package can be extracted without disentangling
// history from the platform drizzle journal. Every table this package
// owns — including its ledger — lives in its own `preferences` Postgres
// schema, never `public`; see docs/package-migrations.md.
import postgres from "postgres";

export interface PreferencesMigration {
  name: string;
  sql: string;
}

const SCHEMA = "preferences";

export const preferencesMigrations: readonly PreferencesMigration[] = [
  {
    name: "0001_user_preferences",
    sql: `
      CREATE TABLE IF NOT EXISTS "preferences"."user_preferences" (
        "tenant_id" text NOT NULL,
        "principal_id" text NOT NULL,
        "data" jsonb NOT NULL DEFAULT '{}',
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "principal_id")
      );
    `,
  },
];

const LEDGER_TABLE = "preferences_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyPreferencesMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyPreferencesMigrations(
  databaseUrl: string,
): Promise<ApplyPreferencesMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of preferencesMigrations) {
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
          `preferences migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
