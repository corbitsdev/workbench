// Package-owned migrations for @corbits/agent-directory. Bookkeeping
// uses its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every table
// this package owns — including its ledger — lives in its own
// `agent_directory` Postgres schema, never `public`; see
// docs/package-migrations.md. Copies `@corbits/config-profiles`'
// `applyConfigProfilesMigrations` shape exactly.
import postgres from "postgres";

export interface AgentDirectoryMigration {
  name: string;
  sql: string;
}

const SCHEMA = "agent_directory";

export const agentDirectoryMigrations: readonly AgentDirectoryMigration[] = [
  {
    name: "0001_definition_skills",
    sql: `
      CREATE TABLE IF NOT EXISTS "agent_directory"."definition_skills" (
        "asset_id" text PRIMARY KEY,
        "skills" jsonb NOT NULL DEFAULT '[]',
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

const LEDGER_TABLE = "agent_directory_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyAgentDirectoryMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyAgentDirectoryMigrations(
  databaseUrl: string,
): Promise<ApplyAgentDirectoryMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of agentDirectoryMigrations) {
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
          `agent-directory migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
