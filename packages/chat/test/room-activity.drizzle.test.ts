// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `reactions.drizzle.test.ts`.
// Runs against its own scratch database.
//
// `room-messages.test.ts` proves the activity summary's shape and the
// timeline's paging against the in-memory store, which stores its
// timestamps as the very ISO strings its cursors carry and so can never
// show what real `timestamptz` columns do to either. This exercises the
// real `createDrizzleRoomMessageStore` against real rows: the summary a
// workbench-list row renders, and a page boundary landing inside a burst
// of messages that share a millisecond.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleRoomMessageStore } from "../src/room-messages";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_room_activity_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT = "tnt_1";
const OTHER_TENANT = "tnt_2";
const BUSY = "run_busy";
const QUIET = "run_quiet";
const EMPTY = "run_empty";

describeIfDb("createDrizzleRoomMessageStore: listActivity", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(
    run: (sql: postgres.Sql) => Promise<void>,
  ): Promise<void> {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
    await applyChatMigrations(scratchUrl);
  });

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  });

  test("summarizes each workbench from its own read cursor, against real rows", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleRoomMessageStore(drizzle(sql));
      const post = (
        tenantId: string,
        workbenchId: string,
        id: string,
        text: string,
      ) =>
        store.insertMessage({
          id,
          tenantId,
          workbenchId,
          sender: { name: null, address: "prn_alice@acme.example" },
          parts: [{ kind: "text", text }],
        });

      // Serial, so the timestamps are strictly increasing and the
      // "newest" the summary reports is unambiguous.
      const first = await post(TENANT, BUSY, "msg_busy_1", "first");
      await post(TENANT, BUSY, "msg_busy_2", "second");
      const newest = await post(TENANT, BUSY, "msg_busy_3", "  third   one ");
      await post(TENANT, QUIET, "msg_quiet_1", "only");
      await post(OTHER_TENANT, BUSY, "msg_other_1", "another tenant's");

      const activity = await store.listActivity({
        tenantId: TENANT,
        workbenches: [
          { workbenchId: BUSY, sinceCreatedAt: first.createdAt },
          { workbenchId: QUIET },
          { workbenchId: EMPTY },
        ],
      });

      expect(activity[BUSY]).toEqual({
        lastActivityAt: newest.createdAt,
        unreadCount: 2,
        preview: "third one",
      });
      // No cursor means everything is unread — never a silent zero.
      expect(activity[QUIET]?.unreadCount).toBe(1);
      // A workbench with no messages reports nothing at all rather than
      // a zero date or an invented snippet.
      expect(activity[EMPTY]).toBeUndefined();
      // The other tenant's message never leaks into this tenant's row.
      expect(activity[BUSY]?.preview).not.toContain("another tenant");
    } finally {
      await sql.end();
    }
  });

  // A cursor is `created_at` rendered to an ISO string, which carries
  // milliseconds and nothing finer. Stored at Postgres' default
  // microsecond precision, a burst of messages sharing a millisecond
  // straddling a page boundary matches neither half of the keyset
  // predicate — `created_at < cursor` (the stored value is larger) nor
  // `created_at = cursor` (it is never equal) — and those messages fall
  // out of the timeline entirely between pages.
  test("paging a burst written inside one millisecond loses no message", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleRoomMessageStore(drizzle(sql));
      const total = 120;
      const posted: string[] = [];
      for (let index = 0; index < total; index += 1) {
        const message = await store.insertMessage({
          id: `msg_burst_${String(index).padStart(3, "0")}`,
          tenantId: TENANT,
          workbenchId: "run_burst",
          sender: { name: null, address: "prn_alice@acme.example" },
          parts: [{ kind: "text", text: `burst ${index}` }],
        });
        posted.push(message.id);
      }

      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listMessages(
          cursor === undefined
            ? { tenantId: TENANT, workbenchId: "run_burst" }
            : { tenantId: TENANT, workbenchId: "run_burst", cursor },
        );
        paged.push(...page.items.map((message) => message.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(paged).toHaveLength(total);
      expect(new Set(paged).size).toBe(total);
      expect([...paged].sort()).toEqual([...posted].sort());
    } finally {
      await sql.end();
    }
  });

  test("an attachment-only newest message previews as nothing, not a placeholder", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleRoomMessageStore(drizzle(sql));
      await store.insertMessage({
        id: "msg_silent_1",
        tenantId: TENANT,
        workbenchId: "run_silent",
        sender: { name: null, address: "prn_alice@acme.example" },
        parts: [{ kind: "event", event: "workbench.member-joined", data: {} }],
      });

      const activity = await store.listActivity({
        tenantId: TENANT,
        workbenches: [{ workbenchId: "run_silent" }],
      });

      expect(activity["run_silent"]?.unreadCount).toBe(1);
      expect(activity["run_silent"]).not.toHaveProperty("preview");
    } finally {
      await sql.end();
    }
  });

  // CL-6795: a join/event newest row must not blank the list preview while
  // earlier readable text still exists.
  test("a join notice after readable text keeps the prior preview", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleRoomMessageStore(drizzle(sql));
      await store.insertMessage({
        id: "msg_join_keep_1",
        tenantId: TENANT,
        workbenchId: "run_join_keep",
        sender: { name: null, address: "prn_alice@acme.example" },
        parts: [{ kind: "text", text: "let's pull Scout in" }],
      });
      const joined = await store.insertMessage({
        id: "msg_join_keep_2",
        tenantId: TENANT,
        workbenchId: "run_join_keep",
        sender: { name: null, address: "run_scout@acme.example" },
        runId: "run_scout",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: { address: "run_scout@acme.example" },
          },
        ],
      });

      const activity = await store.listActivity({
        tenantId: TENANT,
        workbenches: [{ workbenchId: "run_join_keep" }],
      });

      expect(activity["run_join_keep"]?.lastActivityAt).toBe(joined.createdAt);
      expect(activity["run_join_keep"]?.preview).toBe("let's pull Scout in");
    } finally {
      await sql.end();
    }
  });
});
