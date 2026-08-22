// Package-owned migrations for @corbits/workflow-deploy-source.
// Bookkeeping uses its own ledger table so the package can be extracted
// without disentangling history from the platform drizzle journal. The
// table this package owns lives in its own `workflow_deploy_source`
// Postgres schema, never `public`; see docs/package-migrations.md.
import postgres from "postgres";

export interface WorkflowDeploySourceMigration {
  name: string;
  sql: string;
}

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

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

const LEDGER_TABLE = "workflow_deploy_source_migrations";

export interface ApplyWorkflowDeploySourceMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyWorkflowDeploySourceMigrations(
  databaseUrl: string,
): Promise<ApplyWorkflowDeploySourceMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of workflowDeploySourceMigrations) {
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
          `workflow_deploy_source migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
