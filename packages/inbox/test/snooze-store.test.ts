// DB-gated integration test for CL-7208's snooze-until persistence and
// claim-and-reopen: proves `setSnoozeUntil`/`findDueSnoozes` write and read
// a real row in the package's own `inbox.snooze` table (applied through
// `scripts/db-setup.ts`, the same path `apps/hub` boots with — see
// `delivery.test.ts` for the pattern this follows), and that
// `claimAndReopenSnooze` actually flips a real mailbox message back to
// `open` and removes the snooze row once `until` has passed. Runs against
// its own scratch database, never the developer's or the walking-skeleton
// suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  enrichMailboxMessage,
  getMailboxMessage,
  writeMailboxMessage,
} from "@corbits/mailbox";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createInboxRoutes } from "../src/routes";
import { dbGate } from "../../../scripts/e2e/db-gate";
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
const describeIfDb = dbGate(databaseUrl, import.meta.path);

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

  test("a sweep claim racing the route's own snooze write never strands the message `snoozed` with no way to reopen it", async () => {
    // Regression test for a race a Critique pass on CL-7208 found and
    // reproduced: `POST /:id/snooze` used to persist `until` and flip
    // `status` to `snoozed` as two separate statements. A sweep tick's
    // `claimAndReopenSnooze` landing in the gap between them could see the
    // snooze row before the status flip landed, no-op (the message wasn't
    // `snoozed` yet) and delete the row as harmless cleanup — and then the
    // route's own status flip would still land afterward, leaving the
    // message stuck `snoozed` with the row that was supposed to reopen it
    // already gone. `routes.ts` now runs both writes in one transaction so
    // the row is invisible to a concurrent claim until the flip commits
    // with it; this drives the same interleaving the bug needed and
    // asserts the message is never left `snoozed` with zero snooze rows.
    const mailboxDb = createMailboxDb(scratchUrl);
    try {
      const written = await writeMailboxMessage(mailboxDb.db, {
        tenantId,
        principalId,
        address: `${principalId}@inbox.test`,
        fromAddress: "routine:test",
        subject: "Race the sweep",
        body: "test body",
      });
      const messageId = written?.id;
      if (messageId === undefined) throw new Error("message not written");
      const scope = { tenantId, principalId, id: messageId };

      const app = new Hono<TenantEnv>();
      app.use("*", async (c, next) => {
        c.set("tenant", { id: tenantId } as never);
        c.set("principal", { id: principalId } as never);
        await next();
      });
      app.route(
        "/",
        createInboxRoutes({
          db: mailboxDb.db,
          bus: createInMemoryMailboxEventBus(),
        }),
      );

      const until = new Date(Date.now() + 50);
      // A "due" check has to compare against a fixed point safely past
      // `until`, not real wall-clock time at check time — the whole
      // request/claim/verify round trip below runs well under 50ms, so a
      // `new Date()` taken after it finishes can still be *before*
      // `until`, which would make an already-correct row look "not due
      // yet" rather than reopened. `wellPastUntil` is what the real sweep
      // would eventually pass once `until` has genuinely elapsed.
      const wellPastUntil = new Date(until.getTime() + 60_000);

      const [response] = await Promise.all([
        app.request(`/${messageId}/snooze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ until: until.toISOString() }),
        }),
        // Fired concurrently with the route's own write, already past
        // `until` — exactly the timing the bug needed: the sweep
        // considers the row due from the moment it can see it at all.
        claimAndReopenSnooze(
          mailboxDb.db,
          { tenantId, principalId, messageId },
          wellPastUntil,
        ),
      ]);
      expect(response.status).toBe(200);

      const message = await getMailboxMessage(mailboxDb.db, scope);
      const due = await findDueSnoozes(mailboxDb.db, wellPastUntil);
      const hasSnoozeRow = due.some((r) => r.messageId === messageId);

      // The invariant the bug violated: never `snoozed` with nothing left
      // to ever reopen it. Whichever side of the race won, the message
      // must end up either genuinely `open` (the claim won) or `snoozed`
      // with its row still there to be claimed on a later tick (the route
      // won) — never `snoozed` with the row already gone.
      if (message?.status === "snoozed") {
        expect(hasSnoozeRow).toBe(true);
      } else {
        expect(message?.status).toBe("open");
      }
    } finally {
      await mailboxDb.close();
    }
  });
});
