// Package-owned migrations for @corbits/evals. Bookkeeping uses its
// own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every
// table this package owns — including its ledger — lives in its own
// `evals` Postgres schema, never `public`; see
// docs/package-migrations.md.
import postgres from "postgres";

export interface EvalsMigration {
  name: string;
  sql: string;
}

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

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyEvalsMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyEvalsMigrations(
  databaseUrl: string,
): Promise<ApplyEvalsMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of evalsMigrations) {
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
          `evals migration ${migration.name} failed: ${message}`,
          {
            cause: err,
          },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
