// Package-owned migrations for `@corbits/notify`'s one product table,
// following the same ledger pattern as `@corbits/schedules`: bookkeeping in
// this package's own table so its history stays extractable on its own.
// One migration, in final shape — the table is new, so there is nothing to
// alter and nothing to backfill.
import postgres from "postgres";

export interface NotifyMigration {
  name: string;
  sql: string;
}

export const notifyMigrations: readonly NotifyMigration[] = [
  {
    name: "0001_notify_dispatch",
    sql: `
      CREATE TABLE IF NOT EXISTS "notify_dispatch" (
        "id" text PRIMARY KEY,
        "mailbox_row_id" text NOT NULL,
        "tenant_id" text NOT NULL,
        "principal_id" text NOT NULL,
        "sink_name" text NOT NULL,
        "status" text NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "notify_dispatch_row_sink_unique"
          UNIQUE ("mailbox_row_id", "sink_name")
      );
      CREATE INDEX IF NOT EXISTS "notify_dispatch_due_idx"
        ON "notify_dispatch" ("status", "next_attempt_at");
    `,
  },
];

const LEDGER_TABLE = "notify_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ApplyNotifyMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply `notifyMigrations` against `databaseUrl`, idempotently. Failures name
 * the migration and the underlying error, so a partial apply is loud here
 * rather than silent at the next boot.
 */
export async function applyNotifyMigrations(
  databaseUrl: string,
): Promise<ApplyNotifyMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const rows = await sql.unsafe(
      `SELECT name FROM ${quoteIdentifier(LEDGER_TABLE)}`,
    );
    const alreadyApplied = new Set(rows.map((row) => String(row["name"])));
    const applied: string[] = [];
    for (const migration of notifyMigrations) {
      if (alreadyApplied.has(migration.name)) continue;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO ${quoteIdentifier(LEDGER_TABLE)} (name) VALUES ($1)`,
            [migration.name],
          );
        });
        applied.push(migration.name);
      } catch (error) {
        throw new Error(
          `@corbits/notify migration ${JSON.stringify(migration.name)} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    return { applied, alreadyApplied: [...alreadyApplied] };
  } finally {
    await sql.end();
  }
}
