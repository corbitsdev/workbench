// DB-gated reachability probe for the derived `_e2e` sibling database. Every
// DB-gated suite redirects to `<DATABASE_URL's database>_e2e` (via
// e2eDatabaseUrl / dbGate) and owns that sibling outright — but nothing in a
// fresh CI e2e job provisions it except scripts/docker-e2e-init.sh and
// scripts/db-setup.ts (see those). This suite is the "gate boot test": when
// DATABASE_URL's base database is up but the `_e2e` sibling is missing, the
// failure must carry a provisioning hint — not a raw `3D000` connect error —
// so a miswired pipeline points at the exact fix instead of a terse Postgres
// code.
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
    `DATABASE_URL) is not reachable. Provision it with \`bun scripts/db-setup.ts\` ` +
    `(which creates the sibling alongside the base database) or, for the docker ` +
    `compose/CI postgres, by mounting scripts/docker-e2e-init.sh as an ` +
    `initdb.d script (${TEST_COMPOSE_UP}). ${MISSING_DATABASE_HINT}`
  );
}

/** Answers 1 when `SELECT 1` against the given url succeeds, else undefined
 * (so the caller can fail with a provisioning-hint error rather than the raw
 * connect failure). */
async function trySelectOne(databaseUrl: string): Promise<number | undefined> {
  const url = new URL(databaseUrl);
  const handle = createDB({
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  });
  try {
    const rows = await handle.db.execute<{ "?column?": number }>(sql`SELECT 1`);
    return rows[0]?.["?column?"] ?? undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

describeIfDb("e2e _e2e sibling database reachability", () => {
  test("the derived _e2e sibling answers SELECT 1, with a provisioning hint otherwise", async () => {
    if (databaseUrl === undefined) return;
    const database = new URL(databaseUrl).pathname.replace(/^\//, "");
    // dbGate would already have thrown had the resolver regressed into a
    // non-_e2e URL; this pins it at the probe too for anyone reading only this
    // file.
    expect(database.endsWith("_e2e")).toBe(true);

    const one = await trySelectOne(databaseUrl);
    if (one === undefined) throw new Error(provisionHint(database));
    expect(one).toBe(1);
  }, 30_000);
});
