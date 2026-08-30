// Package-owned migrations for @corbits/bench. Bookkeeping uses its own
// ledger table so the package can be extracted without disentangling
// history from the platform drizzle journal. Every table this package
// owns — including its ledger — lives in its own `bench` Postgres
// schema, never `public`; see docs/package-migrations.md. Mechanics
// (schema/ledger bootstrap, transactional apply, the advisory lock
// across concurrent hub replicas) live in @corbits/migration-runner —
// this file owns only the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type BenchMigration = PackageMigration;

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

export type ApplyBenchMigrationsReport = ApplyPackageMigrationsReport;

export async function applyBenchMigrations(
  databaseUrl: string,
): Promise<ApplyBenchMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: benchMigrations,
    packageLabel: "bench",
  });
}
