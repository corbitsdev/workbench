// Package-owned migrations for @corbits/inference-catalog. Own ledger, own
// Postgres schema, literal SQL, transactional apply — the convention in
// docs/package-migrations.md. Mechanics (schema/ledger bootstrap,
// transactional apply, the advisory lock across concurrent hub replicas)
// live in @corbits/migration-runner — this file owns only the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type InferenceCatalogMigration = PackageMigration;

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

export type ApplyInferenceCatalogMigrationsReport =
  ApplyPackageMigrationsReport;

export async function applyInferenceCatalogMigrations(
  databaseUrl: string,
): Promise<ApplyInferenceCatalogMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: inferenceCatalogMigrations,
    packageLabel: "inference-catalog",
  });
}
