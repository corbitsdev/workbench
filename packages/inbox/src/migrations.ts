// URL-shaped wrapper around `@corbits/mailbox`'s `runMailboxMigrations` so
// scripts/db-setup.ts can apply it the same way it applies every other
// installed package's migrations.

import {
  createMailboxDb,
  runMailboxMigrations,
} from "@corbits/mailbox";

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
