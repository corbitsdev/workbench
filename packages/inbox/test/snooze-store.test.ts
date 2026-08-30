// DB-gated integration test for CL-7208's snooze-until persistence and
// claim-and-reopen: proves `setSnoozeUntil`/`findDueSnoozes` write and read
// a real row in the package's own `inbox.snooze` table (applied through
// `scripts/db-setup.ts`, the same path `apps/hub` boots with — see
// `delivery.test.ts` for the pattern this follows), and that
// `claimAndReopenSnooze` actually flips a real mailbox message back to
// `open` and removes the snooze row once `until` has passed. Runs against
// its own scratch database, never the developer's or the walking-skeleton
// suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  createMailboxDb,
  enrichMailboxMessage,
  getMailboxMessage,
  writeMailboxMessage,
} from "@corbits/mailbox";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import {
  claimAndReopenSnooze,
  clearSnoozeUntil,
  findDueSnoozes,
  setSnoozeUntil,
} from "../src/snooze-store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_inbox_snooze_test`;
  return url.toString();
}

function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("snooze-store against a real inbox.snooze table", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const tenantId = generateId("tenant");
  const principalId = generateId("principal");

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

    // Platform migrations plus every installed package's, including
    // @corbits/inbox's own `inbox.snooze` table (CL-7208).
    await setupDatabase(scratchUrl);

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      await db.insert(schema.tenant).values({
        id: tenantId,
        name: "Snooze Test Bench",
        slug: `snooze-${tenantId}`,
        domain: `snooze-${tenantId}.localhost`,
      });
      await db.insert(schema.principal).values({
        id: principalId,
        tenantId,
        kind: "agent",
        refId: "not-a-real-agent-instance",
        status: "active",
      });
    } finally {
      await close();
    }
  }, 30000);

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
  });

  test("setSnoozeUntil persists a row findDueSnoozes reads back once due", async () => {
    const mailboxDb = createMailboxDb(scratchUrl);
    try {
      const written = await writeMailboxMessage(mailboxDb.db, {
        tenantId,
        principalId,
        address: `${principalId}@inbox.test`,
        fromAddress: "routine:test",
        subject: "Snooze me",
        body: "test body",
        status: "snoozed",
      });
      expect(written).not.toBeNull();
      const messageId = written?.id;
      if (messageId === undefined) throw new Error("message not written");
      const scope = { tenantId, principalId, id: messageId };

      const future = new Date(Date.now() + 60_000);
      await setSnoozeUntil(mailboxDb.db, scope, future);

      // Not due yet.
      const notYetDue = await findDueSnoozes(mailboxDb.db, new Date());
      expect(notYetDue.find((r) => r.messageId === messageId)).toBeUndefined();

      // Due once `now` passes `until`.
      const afterUntil = new Date(future.getTime() + 1000);
      const due = await findDueSnoozes(mailboxDb.db, afterUntil);
      expect(due.find((r) => r.messageId === messageId)).toEqual({
        tenantId,
        principalId,
        messageId,
      });

      const reopened = await claimAndReopenSnooze(
        mailboxDb.db,
        { tenantId, principalId, messageId },
        afterUntil,
      );
      expect(reopened).toBe(true);

      const message = await getMailboxMessage(mailboxDb.db, scope);
      expect(message?.status).toBe("open");

      // The claim deleted the snooze row: a second claim attempt finds
      // nothing left to reopen.
      const secondClaim = await claimAndReopenSnooze(
        mailboxDb.db,
        { tenantId, principalId, messageId },
        afterUntil,
      );
      expect(secondClaim).toBe(false);
    } finally {
      await mailboxDb.close();
    }
  });

  test("claimAndReopenSnooze no-ops and cleans up a row whose message is no longer snoozed", async () => {
    const mailboxDb = createMailboxDb(scratchUrl);
    try {
      const written = await writeMailboxMessage(mailboxDb.db, {
        tenantId,
        principalId,
        address: `${principalId}@inbox.test`,
        fromAddress: "routine:test",
        subject: "Snooze then manually reopen",
        body: "test body",
        status: "snoozed",
      });
      const messageId = written?.id;
      if (messageId === undefined) throw new Error("message not written");
      const scope = { tenantId, principalId, id: messageId };

      const past = new Date(Date.now() - 1000);
      await setSnoozeUntil(mailboxDb.db, scope, past);

      // Simulate the user manually reopening it before the sweep ran —
      // exactly the race `claimAndReopenSnooze`'s status check guards.
      await enrichMailboxMessage(mailboxDb.db, scope, { status: "open" });

      const due = await findDueSnoozes(mailboxDb.db, new Date());
      expect(due.some((r) => r.messageId === messageId)).toBe(true);

      const reopened = await claimAndReopenSnooze(
        mailboxDb.db,
        { tenantId, principalId, messageId },
        new Date(),
      );
      // The row was due, so the claim wins, but the message was already
      // `open` — nothing to reopen, so this reports false while still
      // cleaning up the now-stale snooze row.
      expect(reopened).toBe(false);

      const stillDue = await findDueSnoozes(mailboxDb.db, new Date());
      expect(stillDue.some((r) => r.messageId === messageId)).toBe(false);
    } finally {
      await mailboxDb.close();
    }
  });

  test("clearSnoozeUntil removes the row without touching the message", async () => {
    const mailboxDb = createMailboxDb(scratchUrl);
    try {
      const written = await writeMailboxMessage(mailboxDb.db, {
        tenantId,
        principalId,
        address: `${principalId}@inbox.test`,
        fromAddress: "routine:test",
        subject: "Snooze then cancel",
        body: "test body",
      });
      const messageId = written?.id;
      if (messageId === undefined) throw new Error("message not written");
      const scope = { tenantId, principalId, id: messageId };

      await setSnoozeUntil(mailboxDb.db, scope, new Date(Date.now() - 1000));
      await clearSnoozeUntil(mailboxDb.db, scope);

      const due = await findDueSnoozes(mailboxDb.db, new Date());
      expect(due.some((r) => r.messageId === messageId)).toBe(false);
    } finally {
      await mailboxDb.close();
    }
  });
});
