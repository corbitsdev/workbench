// DB-gated reachability probe for the derived `_e2e` sibling database. Every
// DB-gated suite redirects to `<DATABASE_URL's database>_e2e` (via
// e2eDatabaseUrl / dbGate) and owns that sibling outright — but nothing in a
// fresh CI e2e job provisions it except scripts/db-setup.ts (see it). This
// suite is the "gate boot test": when DATABASE_URL's base database is up but
// the `_e2e` sibling is missing, the failure must carry a provisioning hint —
// not a raw `3D000` connect error — so a miswired pipeline points at the exact
// fix instead of a terse Postgres code. Beyond plain connectivity it also
// asserts the sibling's schema is migrated (the platform `tenant` table
// exists), so a direct-DB suite like the mailbox ones (which insert
// `tenant`/`principal` with no hub boot) is not order-dependent on some
// hub-booting suite migrating first.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createDB } from "@intx/db";
import { e2eDatabaseUrl } from "./lib/database-url";
import { dbGate, MISSING_DATABASE_HINT, TEST_COMPOSE_UP } from "./lib/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function provisionHint(database: string): string {
  return (
    `The e2e sibling database ${JSON.stringify(database)} (the _e2e of your ` +
    `DATABASE_URL) is not provisioned. Provision it with \`bun scripts/db-setup.ts\` ` +
    `(which creates AND migrates the sibling alongside the base database) ` +
    `(${TEST_COMPOSE_UP}). ${MISSING_DATABASE_HINT}`
  );
}

// The `db` handle createDB returns (same shape the other DB-gated suites use:
// `handle.db` for queries, `handle.close()` for teardown).
type DbHandle = Awaited<ReturnType<typeof createDB>>;

async function withDb<T>(databaseUrl: string, run: (db: DbHandle["db"]) => Promise<T>): Promise<T> {
  const url = new URL(databaseUrl);
  const handle = createDB({
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  });
  try {
    return await run(handle.db);
  } finally {
    await handle.close();
  }
}

/** Answers "reachable" when `SELECT 1` succeeds, else undefined. */
async function trySelectOne(databaseUrl: string): Promise<boolean> {
  try {
    return await withDb(databaseUrl, async (db) => {
      await db.execute(sql`SELECT 1`);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Answers "schema migrated" when the platform `tenant` table exists in the
 * sibling, else false. Catching the connect failure here keeps the caller able
 * to emit the provisioning hint rather than a raw `42P01`/`3D000`.
 */
async function isTenantTablePresent(databaseUrl: string): Promise<boolean> {
  try {
    return await withDb(databaseUrl, async (db) => {
      const rows = await db.execute<{ present: string | null }>(
        sql`select to_regclass('public."tenant"') as present`,
      );
      return rows[0]?.present != null;
    });
  } catch {
    return false;
  }
}

describeIfDb("e2e _e2e sibling database provisioned", () => {
  test("the derived _e2e sibling is reachable, with a provisioning hint otherwise", async () => {
    if (databaseUrl === undefined) return;
    const database = new URL(databaseUrl).pathname.replace(/^\//, "");
    // dbGate would already have thrown had the resolver regressed into a
    // non-_e2e URL; this pins it at the probe too for anyone reading only this
    // file.
    expect(database.endsWith("_e2e")).toBe(true);

    const reachable = await trySelectOne(databaseUrl);
    if (!reachable) throw new Error(provisionHint(database));
    expect(reachable).toBe(true);
  }, 30_000);

  test("the derived _e2e sibling has the migrated platform schema (tenant table), so direct-DB suites are not order-dependent", async () => {
    if (databaseUrl === undefined) return;
    const database = new URL(databaseUrl).pathname.replace(/^\//, "");
    const present = await isTenantTablePresent(databaseUrl);
    if (!present) throw new Error(provisionHint(database));
    expect(present).toBe(true);
  }, 30_000);
});
