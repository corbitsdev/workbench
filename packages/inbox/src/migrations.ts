// Two independent migration stories for `@corbits/inbox`:
//
// - `applyMailboxMigrations`: a URL-shaped wrapper around
//   `@corbits/mailbox`'s own `runMailboxMigrations`, so scripts/db-setup.ts
//   can apply it the same way it applies every other installed package's
//   migrations. That package keeps its own ledger inside the `mailbox`
//   schema.
// - `applyInboxMigrations`: this package's own product table (CL-7208's
//   `inbox.snooze` — see `./schema.ts` for why `@corbits/mailbox`'s
//   enrichment has no column for a snooze's `until`). Bookkeeping uses its
//   own ledger table, following the same pattern as
//   `@workbench/onboarding`'s `migrations.ts`, so this package's migration
//   history stays extractable on its own.

import { createMailboxDb, runMailboxMigrations } from "@corbits/mailbox";
import postgres from "postgres";

export interface ApplyMailboxMigrationsReport {
  applied: string[];
}

/**
 * Apply the mailbox package's migrations against `databaseUrl`. The package
 * keeps its own ledger inside the `mailbox` schema; this wrapper only opens
 * a short-lived handle, runs the migrator, and closes it.
 *
 * The report's `applied` list is best-effort: the package's runner does not
 * return which rows it just wrote, so a successful call reports a single
 * sentinel so db-setup can log that the step ran without error.
 */
export async function applyMailboxMigrations(
  databaseUrl: string,
): Promise<ApplyMailboxMigrationsReport> {
  const { db, close } = createMailboxDb(databaseUrl);
  try {
    await runMailboxMigrations(db);
    return { applied: ["mailbox"] };
  } finally {
    await close();
  }
}

export interface InboxMigration {
  name: string;
  sql: string;
}

const SCHEMA = "inbox";
const LEDGER_TABLE = "inbox_migrations";

export const inboxMigrations: readonly InboxMigration[] = [
  {
    name: "0001_snooze",
    sql: `
      CREATE TABLE IF NOT EXISTS "inbox"."snooze" (
        "tenant_id" text NOT NULL,
        "principal_id" text NOT NULL,
        "message_id" text NOT NULL,
        "until" timestamptz NOT NULL,
        PRIMARY KEY ("tenant_id", "principal_id", "message_id")
      );
      CREATE INDEX IF NOT EXISTS "inbox_snooze_until_idx" ON "inbox"."snooze" ("until");
    `,
  },
];

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyInboxMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply `inboxMigrations` against `databaseUrl`, idempotently: a migration
 * already recorded in the ledger is skipped, never re-run. Failures are
 * loud — the migration name and the underlying error are both surfaced.
 */
export async function applyInboxMigrations(
  databaseUrl: string,
): Promise<ApplyInboxMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of inboxMigrations) {
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
      } catch (error) {
        throw new Error(
          `@corbits/inbox migration ${JSON.stringify(migration.name)} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
