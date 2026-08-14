// Package-owned migrations for @workbench/access-policy. Bookkeeping
// uses its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every table
// this package owns — including its ledger — lives in its own
// `access_policy` Postgres schema, never `public`; see
// docs/package-migrations.md.
import postgres from "postgres";

export interface AccessPolicyMigration {
  name: string;
  sql: string;
}

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

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyAccessPolicyMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyAccessPolicyMigrations(
  databaseUrl: string,
): Promise<ApplyAccessPolicyMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of accessPolicyMigrations) {
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
          `access_policy migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
