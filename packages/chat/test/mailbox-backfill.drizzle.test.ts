// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `mailbox-fanout.drizzle.test.ts`. Runs the mailbox backfill replay
// (CL-7454) against a real `@corbits/mailbox` schema, with an in-memory
// chat/thread store standing in for the workbench's own tables — this
// package's own `chat.mailbox_backfill_cursor` table is exercised only
// through the in-memory cursor store here; `createDrizzleMailboxBackfillCursorStore`'s
// SQL shape is proved by this same suite reusing it against the live
// database below.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { createMailboxDb, runMailboxMigrations } from "@corbits/mailbox";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { createDrizzleMailboxWriter } from "../src/mailbox-fanout";
import {
  runMailboxBackfillPass,
  createDrizzleMailboxBackfillCursorStore,
  createInMemoryMailboxBackfillCursorStore,
  type MailboxBackfillMessageSource,
} from "../src/mailbox-backfill";
import { applyChatMigrations } from "../src/migrations";
import type { RoomMessage } from "../src/room-messages";
import { createInMemoryThreadStore } from "../src/threads";
import type { ParticipantRecord } from "../src/participants";

function scratchUrlFor(e2eUrl: string, suffix: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_${suffix}`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_ID = "tnt_1";
const DOMAIN = "acme.example";
const ALICE = "prn_alice";
const BOB = "prn_bob";
const AGENT_ADDRESS = "ins_echo1@acme.example";
const WORKBENCH_ID = "wb_1";

describeIfDb(
  "runMailboxBackfillPass against a live @corbits/mailbox schema",
  () => {
    const scratchUrl = scratchUrlFor(
      databaseUrl ?? "postgres://localhost:5432/unused",
      "chat_mailbox_backfill_drizzle_test",
    );
    const scratchTarget = new URL(scratchUrl);
    const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

    async function withMaintenance(fn: (m: postgres.Sql) => Promise<void>) {
      const maintenanceUrl = new URL(scratchUrl);
      maintenanceUrl.pathname = "/postgres";
      const maintenance = postgres(maintenanceUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await fn(maintenance);
      } finally {
        await maintenance.end();
      }
    }

    beforeAll(async () => {
      await withMaintenance(async (m) => {
        await m.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
        await m.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
      });
    }, 20000);

    afterAll(async () => {
      await withMaintenance(async (m) => {
        await m.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      });
    }, 20000);

    test("a three-message thread (person, agent, person) in a two-human workbench produces the right copies with parent links, and a second pass writes nothing", async () => {
      const { db: mailboxDb, close } = createMailboxDb(scratchUrl);
      await mailboxDb.execute(sql`
        CREATE TABLE IF NOT EXISTS "tenant" ("id" text PRIMARY KEY)
      `);
      await mailboxDb.execute(sql`
        CREATE TABLE IF NOT EXISTS "principal" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE
        )
      `);
      await mailboxDb.execute(
        sql`INSERT INTO "tenant" ("id") VALUES (${TENANT_ID})`,
      );
      await mailboxDb.execute(
        sql`INSERT INTO "principal" ("id", "tenant_id") VALUES (${ALICE}, ${TENANT_ID}), (${BOB}, ${TENANT_ID})`,
      );
      await runMailboxMigrations(mailboxDb);
      await applyChatMigrations(scratchUrl);

      const chatClient = postgres(scratchUrl, {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        const writer = createDrizzleMailboxWriter(mailboxDb);
        const chatDb = drizzle(chatClient);

        const participants: ParticipantRecord[] = [
          { address: ALICE, handle: "alice" },
          { address: BOB, handle: "bob" },
          { address: AGENT_ADDRESS, handle: "echo" },
        ];

        // msg_2 and msg_3 both reply to msg_1, inside the same depth-1
        // reply thread — the "parent links" this test proves out: both
        // carry msg_1 as their thread ancestry's own `In-Reply-To`, not a
        // chain of "whichever message came immediately before".
        const threads = createInMemoryThreadStore();
        const replyThread = await threads.openReplyThread({
          tenantId: TENANT_ID,
          workbenchId: WORKBENCH_ID,
          parentMessageId: "msg_1",
        });
        await threads.assignMessage({
          tenantId: TENANT_ID,
          workbenchId: WORKBENCH_ID,
          threadId: replyThread.id,
          messageId: "msg_2",
        });
        await threads.assignMessage({
          tenantId: TENANT_ID,
          workbenchId: WORKBENCH_ID,
          threadId: replyThread.id,
          messageId: "msg_3",
        });

        const rows: RoomMessage[] = [
          {
            id: "msg_1",
            workbenchId: WORKBENCH_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            sender: { name: null, address: `${ALICE}@${DOMAIN}` },
            senderPrincipalId: ALICE,
            runId: null,
            threadId: null,
            mailMessageId: null,
            parts: [{ kind: "text", text: "hello from alice" }],
          },
          {
            id: "msg_2",
            workbenchId: WORKBENCH_ID,
            createdAt: "2026-01-01T00:00:01.000Z",
            sender: { name: null, address: AGENT_ADDRESS },
            senderPrincipalId: null,
            runId: "run_1",
            threadId: replyThread.id,
            mailMessageId: null,
            parts: [{ kind: "text", text: "hello from echo" }],
          },
          {
            id: "msg_3",
            workbenchId: WORKBENCH_ID,
            createdAt: "2026-01-01T00:00:02.000Z",
            sender: { name: null, address: `${BOB}@${DOMAIN}` },
            senderPrincipalId: BOB,
            runId: null,
            threadId: replyThread.id,
            mailMessageId: null,
            parts: [{ kind: "text", text: "hello from bob" }],
          },
        ];
        const stamped = new Map<string, string>();

        const messages: MailboxBackfillMessageSource = {
          async listWorkbenchesWithMessages() {
            return [{ tenantId: TENANT_ID, workbenchId: WORKBENCH_ID }];
          },
          async pageMessages(input) {
            const after = input.after;
            return rows
              .filter(
                (row) =>
                  after === undefined ||
                  row.createdAt > after.lastCreatedAt ||
                  (row.createdAt === after.lastCreatedAt &&
                    row.id > after.lastMessageId),
              )
              .map((row) => ({
                ...row,
                mailMessageId: stamped.get(row.id) ?? row.mailMessageId,
              }))
              .slice(0, input.limit);
          },
        };

        const cursorStore = createDrizzleMailboxBackfillCursorStore(chatDb);

        const deps = {
          messages,
          roomMessages: {
            async stampMailMessageId(input: {
              messageId: string;
              mailMessageId: string;
            }) {
              stamped.set(input.messageId, input.mailMessageId);
            },
          },
          threads,
          settings: {
            async getWorkbenchSettings() {
              return { settings: { "chat/participants": participants } };
            },
          },
          mailbox: {
            writer,
            resolveKnownPrincipalIds: async (
              _tenantId: string,
              candidateIds: readonly string[],
            ) =>
              new Set(candidateIds.filter((id) => id === ALICE || id === BOB)),
            resolveTenantDomain: async () => DOMAIN,
          },
          cursors: cursorStore,
        };

        const summary = await runMailboxBackfillPass(deps);
        expect(summary.totalReplayed).toBe(3);

        const persistedRows = await mailboxDb.execute<{
          principal_id: string;
          direction: string;
          message_id: string;
          from_address: string;
        }>(
          sql`SELECT principal_id, direction, message_id, from_address FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID} ORDER BY message_id, principal_id`,
        );
        expect([...persistedRows]).toEqual([
          {
            principal_id: ALICE,
            direction: "outbound",
            message_id: "<msg_1@acme.example>",
            from_address: `${ALICE}@${DOMAIN}`,
          },
          {
            principal_id: BOB,
            direction: "inbound",
            message_id: "<msg_1@acme.example>",
            from_address: `${ALICE}@${DOMAIN}`,
          },
          {
            principal_id: ALICE,
            direction: "inbound",
            message_id: "<msg_2@acme.example>",
            from_address: AGENT_ADDRESS,
          },
          {
            principal_id: BOB,
            direction: "inbound",
            message_id: "<msg_2@acme.example>",
            from_address: AGENT_ADDRESS,
          },
          {
            principal_id: ALICE,
            direction: "inbound",
            message_id: "<msg_3@acme.example>",
            from_address: `${BOB}@${DOMAIN}`,
          },
          {
            principal_id: BOB,
            direction: "outbound",
            message_id: "<msg_3@acme.example>",
            from_address: `${BOB}@${DOMAIN}`,
          },
        ]);

        // msg_2 and msg_3 both hang off the same depth-1 reply thread
        // anchored on msg_1 — both carry msg_1 as their `In-Reply-To`
        // (the thread's own ancestry), not each other.
        const inReplyTos = await mailboxDb.execute<{
          message_id: string;
          in_reply_to: string | null;
        }>(
          sql`SELECT message_id, in_reply_to FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID} AND "principal_id" = ${ALICE} ORDER BY message_id`,
        );
        const byMessageId = new Map(
          [...inReplyTos].map((r) => [r.message_id, r.in_reply_to]),
        );
        expect(byMessageId.get("<msg_1@acme.example>")).toBeNull();
        expect(byMessageId.get("<msg_2@acme.example>")).toBe(
          "<msg_1@acme.example>",
        );
        expect(byMessageId.get("<msg_3@acme.example>")).toBe(
          "<msg_1@acme.example>",
        );

        // A second pass, resuming from the cursor the first pass left,
        // writes nothing new.
        const second = await runMailboxBackfillPass(deps);
        expect(second.totalReplayed).toBe(0);
        const countAfterSecond = await mailboxDb.execute<{ count: string }>(
          sql`SELECT count(*)::text FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID}`,
        );
        expect(countAfterSecond[0]?.count).toBe("6");
      } finally {
        await chatClient.end();
        await close();
      }
    }, 30000);

    test("createDrizzleMailboxBackfillCursorStore persists and advances a per-workbench cursor", async () => {
      const client = postgres(scratchUrl, {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        const chatDb = drizzle(client);
        await applyChatMigrations(scratchUrl);
        const store = createDrizzleMailboxBackfillCursorStore(chatDb);

        expect(await store.get(TENANT_ID, "wb_cursor_test")).toBeUndefined();

        await store.advance(TENANT_ID, "wb_cursor_test", {
          lastMessageId: "msg_1",
          lastCreatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(await store.get(TENANT_ID, "wb_cursor_test")).toEqual({
          lastMessageId: "msg_1",
          lastCreatedAt: "2026-01-01T00:00:00.000Z",
        });

        await store.advance(TENANT_ID, "wb_cursor_test", {
          lastMessageId: "msg_2",
          lastCreatedAt: "2026-01-01T00:00:01.000Z",
        });
        expect(await store.get(TENANT_ID, "wb_cursor_test")).toEqual({
          lastMessageId: "msg_2",
          lastCreatedAt: "2026-01-01T00:00:01.000Z",
        });
      } finally {
        await client.end();
      }
    }, 20000);

    test("the in-memory cursor store's own contract matches the drizzle one's, for tests that don't need a database", async () => {
      const store = createInMemoryMailboxBackfillCursorStore();
      expect(await store.get(TENANT_ID, WORKBENCH_ID)).toBeUndefined();
      await store.advance(TENANT_ID, WORKBENCH_ID, {
        lastMessageId: "msg_9",
        lastCreatedAt: "2026-01-01T00:00:09.000Z",
      });
      expect(await store.get(TENANT_ID, WORKBENCH_ID)).toEqual({
        lastMessageId: "msg_9",
        lastCreatedAt: "2026-01-01T00:00:09.000Z",
      });
    });
  },
);
