// Package-owned migrations for @corbits/tasks. Bookkeeping uses its
// own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every
// table this package owns — including its ledger — lives in its own
// `tasks` Postgres schema, never `public`; see
// docs/package-migrations.md.
import postgres from "postgres";

export interface TaskMigration {
  name: string;
  sql: string;
}

const SCHEMA = "tasks";

export const tasksMigrations: readonly TaskMigration[] = [
  {
    name: "0001_task",
    sql: `
      CREATE TABLE IF NOT EXISTS "tasks"."task" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "principal_id" text NOT NULL,
        "definition_id" text NOT NULL,
        "prompt" text NOT NULL,
        "model_preference" text,
        "status" text NOT NULL,
        "run_id" text NOT NULL,
        "result_mail_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "task_tenant_created_idx"
        ON "tasks"."task" ("tenant_id", "created_at");
      CREATE UNIQUE INDEX IF NOT EXISTS "task_run_id_uidx"
        ON "tasks"."task" ("run_id");
    `,
  },
  {
    name: "0002_planner_run_id",
    sql: `
      ALTER TABLE "tasks"."task" ADD COLUMN IF NOT EXISTS "planner_run_id" text;
    `,
  },
];

const LEDGER_TABLE = "tasks_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyTasksMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyTasksMigrations(
  databaseUrl: string,
): Promise<ApplyTasksMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of tasksMigrations) {
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
          `tasks migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
