// Package-owned migrations for @corbits/preferences. Bookkeeping uses its
// own ledger table so the package can be extracted without disentangling
// history from the platform drizzle journal. Every table this package
// owns — including its ledger — lives in its own `preferences` Postgres
// schema, never `public`; see docs/package-migrations.md. Mechanics
// (schema/ledger bootstrap, transactional apply, the advisory lock
// across concurrent hub replicas) live in @corbits/migration-runner —
// this file owns only the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type PreferencesMigration = PackageMigration;

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

export type ApplyPreferencesMigrationsReport = ApplyPackageMigrationsReport;

export async function applyPreferencesMigrations(
  databaseUrl: string,
): Promise<ApplyPreferencesMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: preferencesMigrations,
    packageLabel: "preferences",
  });
}
