// Package-owned migrations for @corbits/config-profiles. Bookkeeping uses
// its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every table
// this package owns — including its ledger — lives in its own
// `config_profiles` Postgres schema, never `public`; see
// docs/package-migrations.md. Copies `@corbits/preferences`'
// `applyPreferencesMigrations` shape exactly (the reference the docs point
// new packages at is `@corbits/insights`, but `@corbits/preferences` is
// the smaller, single-table match for this package's own shape).
import postgres from "postgres";

export interface ConfigProfilesMigration {
  name: string;
  sql: string;
}

const SCHEMA = "config_profiles";

export const configProfilesMigrations: readonly ConfigProfilesMigration[] = [
  {
    name: "0001_profile",
    sql: `
      CREATE TABLE IF NOT EXISTS "config_profiles"."profile" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "entries" jsonb NOT NULL DEFAULT '[]',
        "created_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "profile_tenant_id_idx"
        ON "config_profiles"."profile" ("tenant_id");
    `,
  },
];

const LEDGER_TABLE = "config_profiles_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyConfigProfilesMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyConfigProfilesMigrations(
  databaseUrl: string,
): Promise<ApplyConfigProfilesMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of configProfilesMigrations) {
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
          `config-profiles migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
