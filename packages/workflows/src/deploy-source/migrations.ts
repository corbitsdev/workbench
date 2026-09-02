// Package-owned migrations for @corbits/workflows's ./deploy-source.
// Bookkeeping uses its own ledger table so the package can be extracted
// without disentangling history from the platform drizzle journal. The
// table this package owns lives in its own `workflow_deploy_source`
// Postgres schema, never `public`; see docs/package-migrations.md.
// Mechanics (schema/ledger bootstrap, transactional apply, the
// advisory lock across concurrent hub replicas) live in
// @corbits/migration-runner — this file owns only the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type WorkflowDeploySourceMigration = PackageMigration;

const SCHEMA = "workflow_deploy_source";

export const workflowDeploySourceMigrations: readonly WorkflowDeploySourceMigration[] =
  [
    {
      name: "0001_workflow_deploy_source",
      sql: `
      CREATE TABLE IF NOT EXISTS "workflow_deploy_source"."workflow_deploy_source" (
        "anchor_run_id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "deployment_domain" text NOT NULL,
        "source" jsonb NOT NULL,
        "entry" text NOT NULL,
        "pin" text,
        "definition_asset_id" text NOT NULL,
        "source_ref" text,
        "source_authority_principal_id" text NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "workflow_deploy_source_tenant_idx"
        ON "workflow_deploy_source"."workflow_deploy_source" ("tenant_id");
    `,
    },
  ];

const LEDGER_TABLE = "workflow_deploy_source_migrations";

export type ApplyWorkflowDeploySourceMigrationsReport =
  ApplyPackageMigrationsReport;

export async function applyWorkflowDeploySourceMigrations(
  databaseUrl: string,
): Promise<ApplyWorkflowDeploySourceMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: workflowDeploySourceMigrations,
    packageLabel: "workflow_deploy_source",
  });
}
