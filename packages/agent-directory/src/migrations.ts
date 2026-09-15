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
  // CL-7592 cuts the Workbench-owned directory store over to the
  // definition assets' own pinned-skills stanzas: the table 0001 created
  // is dropped, never read again. Append-only like every ledger entry
  // before it — history is not rewritten, the store is deleted forward.
  //
  // Parity (stanza ⊇ store, so the drop loses nothing): from the
  // table's introduction (baabe260) to this cutover, every `setSkills`
  // writer dual-wrote the identical skill set into the asset stanza
  // first — create (`createAgentDefinitionCore`), `PUT
  // /:definitionId/skills`, the skill-pin route, and the
  // capability-add skill path all `reindexPinnedSkills` the written
  // workflow and persist the store only in `afterWrite`, which runs
  // after the asset write succeeds. The store has no delete path and
  // reads a missing row as []. A crash between the two writes leaves
  // the stanza ahead (safe: reads now come from the stanza); no path
  // writes the store without first writing the stanza, so no dropped
  // row can name a skill its asset's stanza lacks.
  {
    name: "0002_drop_definition_skills",
    sql: `DROP TABLE IF EXISTS "agent_directory"."definition_skills";`,
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
