// Package-owned migrations for @corbits/inference-catalog. Own ledger, own
// Postgres schema, literal SQL, transactional apply — the convention in
// docs/package-migrations.md.
import postgres from "postgres";

export interface InferenceCatalogMigration {
  name: string;
  sql: string;
}

const SCHEMA = "inference_catalog";

export const inferenceCatalogMigrations: readonly InferenceCatalogMigration[] =
  [
    {
      name: "0001_bench_model_policy",
      sql: `
      CREATE TABLE IF NOT EXISTS "inference_catalog"."bench_model_policy" (
        "tenant_id" text PRIMARY KEY,
        "allow" text[] NOT NULL DEFAULT '{}',
        "deny" text[] NOT NULL DEFAULT '{}',
        "max_input_usd_per_mtok" numeric,
        "max_output_usd_per_mtok" numeric,
        "ceiling_is_hard" boolean NOT NULL DEFAULT false,
        "concept_ceilings" jsonb NOT NULL DEFAULT '{}',
        "provider_preference" jsonb,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `,
    },
  ];

const LEDGER_TABLE = "inference_catalog_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyInferenceCatalogMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyInferenceCatalogMigrations(
  databaseUrl: string,
): Promise<ApplyInferenceCatalogMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of inferenceCatalogMigrations) {
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
          `inference-catalog migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
