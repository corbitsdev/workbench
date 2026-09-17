// Package-owned migrations for @workbench/onboarding. Bookkeeping uses
// its own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every table
// this package owns — including its ledger — lives in its own
// `onboarding` Postgres schema, never `public`; see
// docs/package-migrations.md.
import postgres from "postgres";

export interface OnboardingMigration {
  name: string;
  sql: string;
}

const SCHEMA = "onboarding";

export const onboardingMigrations: readonly OnboardingMigration[] = [
  {
    name: "0001_pending_seed",
    sql: `
      CREATE TABLE IF NOT EXISTS "onboarding"."pending_seed" (
        "user_id" text NOT NULL,
        "tenant_id" text NOT NULL,
        "provider" text NOT NULL,
        "payload" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        PRIMARY KEY ("user_id", "tenant_id")
      );
    `,
  },
  {
    // CL-8210: tenant_id becomes a real foreign key into Interchange's own
    // tenant table, ON DELETE CASCADE. user_id stays a plain text column —
    // it is the workbench web app's better-auth user id, not an
    // Interchange principal id, so there is no Interchange row to
    // reference (see packages/onboarding/src/schema.ts).
    name: "0002_pending_seed_tenant_fk",
    sql: `
      ALTER TABLE "onboarding"."pending_seed"
        ADD CONSTRAINT "pending_seed_tenant_id_fkey"
          FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant" ("id") ON DELETE CASCADE;
    `,
  },
];

const LEDGER_TABLE = "onboarding_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyOnboardingMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyOnboardingMigrations(
  databaseUrl: string,
): Promise<ApplyOnboardingMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of onboardingMigrations) {
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
        throw new Error(`onboarding migration ${migration.name} failed: ${message}`, {
          cause: err,
        });
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
