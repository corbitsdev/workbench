// Package-owned migrations for @workbench/access-policy. Bookkeeping
// uses its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every table
// this package owns — including its ledger — lives in its own
// `access_policy` Postgres schema, never `public`; see
// docs/package-migrations.md. Mechanics (schema/ledger bootstrap,
// transactional apply, the advisory lock across concurrent hub
// replicas) live in @corbits/migration-runner — this file owns only
// the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type AccessPolicyMigration = PackageMigration;

const SCHEMA = "access_policy";

export const accessPolicyMigrations: readonly AccessPolicyMigration[] = [
  {
    name: "0001_policy",
    sql: `
      CREATE TABLE IF NOT EXISTS "access_policy"."policy" (
        "tenant_id" text PRIMARY KEY,
        "self_signup" text NOT NULL DEFAULT 'off',
        "allowed_domains" text NOT NULL DEFAULT '[]',
        "tenancy_creation" text NOT NULL DEFAULT 'owners',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "policy_self_signup_check"
          CHECK ("self_signup" IN ('off', 'allowed-domains', 'open')),
        CONSTRAINT "policy_tenancy_creation_check"
          CHECK ("tenancy_creation" IN ('owners', 'owners-admins', 'none'))
      );
    `,
  },
  {
    name: "0002_pending_invite",
    sql: `
      CREATE TABLE IF NOT EXISTS "access_policy"."pending_invite" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "match_type" text NOT NULL,
        "value" text NOT NULL,
        "role_id" text,
        "invited_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "consumed_at" timestamptz,
        CONSTRAINT "pending_invite_match_type_check"
          CHECK ("match_type" IN ('email', 'domain'))
      );
      CREATE INDEX IF NOT EXISTS "pending_invite_value_idx"
        ON "access_policy"."pending_invite" ("value");
      CREATE INDEX IF NOT EXISTS "pending_invite_tenant_idx"
        ON "access_policy"."pending_invite" ("tenant_id");
    `,
  },
];

const LEDGER_TABLE = "access_policy_migrations";

export type ApplyAccessPolicyMigrationsReport = ApplyPackageMigrationsReport;

export async function applyAccessPolicyMigrations(
  databaseUrl: string,
): Promise<ApplyAccessPolicyMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: accessPolicyMigrations,
    packageLabel: "access_policy",
  });
}
