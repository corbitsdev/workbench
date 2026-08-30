// Package-owned migrations for @corbits/evals. Bookkeeping uses its
// own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every
// table this package owns — including its ledger — lives in its own
// `evals` Postgres schema, never `public`; see
// docs/package-migrations.md. Mechanics (schema/ledger bootstrap,
// transactional apply, the advisory lock across concurrent hub
// replicas) live in @corbits/migration-runner — this file owns only
// the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type EvalsMigration = PackageMigration;

const SCHEMA = "evals";

export const evalsMigrations: readonly EvalsMigration[] = [
  {
    name: "0001_run",
    sql: `
      CREATE TABLE IF NOT EXISTS "evals"."run" (
        "id" text PRIMARY KEY,
        "eval_name" text NOT NULL,
        "config_name" text NOT NULL,
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz NOT NULL,
        "steps" jsonb NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "run_eval_name_recorded_idx"
        ON "evals"."run" ("eval_name", "recorded_at");
    `,
  },
];

const LEDGER_TABLE = "evals_migrations";

export type ApplyEvalsMigrationsReport = ApplyPackageMigrationsReport;

export async function applyEvalsMigrations(
  databaseUrl: string,
): Promise<ApplyEvalsMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: evalsMigrations,
    packageLabel: "evals",
  });
}
