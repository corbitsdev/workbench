// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `threads.drizzle.test.ts`. Runs against its own scratch database with
// a minimal control plane (`tenant`/`principal`) the mailbox FKs need.
//
// Proves `createDrizzleMailboxWriter`'s two write paths against a real
// `@corbits/mailbox` schema: `writeOutbound`'s direct insert matches the
// live PARTIAL unique index on `(tenant_id, principal_id, message_key)`
// (`WHERE message_key IS NOT NULL`) — a naive `onConflictDoNothing`
// target with no matching `where` fails loud with "there is no unique or
// exclusion constraint matching the ON CONFLICT specification" against a
// real database, never against the in-memory fakes `mailbox-fanout.test.ts`
// uses — and `writeInbound` (`writeMailboxMessage`) writes a real
// "inbound" row. Both dedupe on a retried `messageKey`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createMailboxDb, runMailboxMigrations } from "@corbits/mailbox";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { createDrizzleMailboxWriter } from "../src/mailbox-fanout";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_mailbox_fanout_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_ID = "tnt_1";
const PRINCIPAL_ID = "prn_alice";
const OTHER_PRINCIPAL_ID = "prn_bob";
const DOMAIN = "acme.example";

describeIfDb("createDrizzleMailboxWriter", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("writeOutbound and writeInbound both write and dedupe against a live schema", async () => {
    const { db, close } = createMailboxDb(scratchUrl);
    try {
      // The minimal control plane the mailbox FKs require — same shape
      // `@corbits/mailbox`'s own test-helpers.ts uses, reimplemented here
      // since that file is excluded from the published package.
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "tenant" ("id" text PRIMARY KEY)
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "principal" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE
        )
      `);
      await db.execute(sql`INSERT INTO "tenant" ("id") VALUES (${TENANT_ID})`);
      await db.execute(
        sql`INSERT INTO "principal" ("id", "tenant_id") VALUES (${PRINCIPAL_ID}, ${TENANT_ID}), (${OTHER_PRINCIPAL_ID}, ${TENANT_ID})`,
      );
      await runMailboxMigrations(db);

      const writer = createDrizzleMailboxWriter(db);
      const messageKey = "<msg_1@acme.example>";

      const outbound = await writer.writeOutbound({
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        address: `${PRINCIPAL_ID}@${DOMAIN}`,
        fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
        subject: "hello",
        body: "hello",
        messageKey,
      });
      expect(outbound).not.toBeNull();

      const inbound = await writer.writeInbound({
        tenantId: TENANT_ID,
        principalId: OTHER_PRINCIPAL_ID,
        address: `${OTHER_PRINCIPAL_ID}@${DOMAIN}`,
        fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
        subject: "hello",
        body: "hello",
        messageKey,
      });
      expect(inbound).not.toBeNull();

      const rows = await db.execute<{
        principal_id: string;
        direction: string;
        message_key: string;
      }>(
        sql`SELECT principal_id, direction, message_key FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID} ORDER BY principal_id`,
      );
      expect([...rows]).toEqual([
        {
          principal_id: PRINCIPAL_ID,
          direction: "outbound",
          message_key: messageKey,
        },
        {
          principal_id: OTHER_PRINCIPAL_ID,
          direction: "inbound",
          message_key: messageKey,
        },
      ]);

      // A retried send is idempotent on messageKey for both directions —
      // this is the same live PARTIAL unique index both `writeOutbound`'s
      // direct insert and `writeMailboxMessage`'s own insert dedupe against.
      const retriedOutbound = await writer.writeOutbound({
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        address: `${PRINCIPAL_ID}@${DOMAIN}`,
        fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
        subject: "hello",
        body: "hello",
        messageKey,
      });
      expect(retriedOutbound).toBeNull();

      const retriedInbound = await writer.writeInbound({
        tenantId: TENANT_ID,
        principalId: OTHER_PRINCIPAL_ID,
        address: `${OTHER_PRINCIPAL_ID}@${DOMAIN}`,
        fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
        subject: "hello",
        body: "hello",
        messageKey,
      });
      expect(retriedInbound).toBeNull();

      const countRows = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID}`,
      );
      expect(countRows[0]?.count).toBe("2");
    } finally {
      await close();
    }
  }, 20000);
});
