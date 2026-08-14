// Package-owned migrations for @corbits/skills. Literal SQL, a ledger
// table the package owns, and one transaction per migration — see
// docs/package-migrations.md. Every table lives in the package's own
// `skills` Postgres schema, never `public`.
import postgres from "postgres";

export interface SkillsMigration {
  name: string;
  sql: string;
}

const SCHEMA = "skills";

export const skillsMigrations: readonly SkillsMigration[] = [
  {
    name: "0001_skill_access",
    sql: `
      CREATE TABLE IF NOT EXISTS "skills"."skill_access" (
        "asset_id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "skill_name" text NOT NULL,
        "creator_principal_id" text NOT NULL,
        "scope" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "skill_access_scope_check"
          CHECK ("scope" IN ('private', 'tenant'))
      );
      CREATE INDEX IF NOT EXISTS "skill_access_tenant_idx"
        ON "skills"."skill_access" ("tenant_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "skill_access_tenant_name_uidx"
        ON "skills"."skill_access" ("tenant_id", "skill_name");
    `,
  },
];

const LEDGER_TABLE = "skills_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplySkillsMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applySkillsMigrations(
  databaseUrl: string,
): Promise<ApplySkillsMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of skillsMigrations) {
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
          `skills migration ${migration.name} failed: ${message}`,
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
