// DB-gated for the Drizzle round-trip, plain unit tests otherwise —
// mirroring `block-responses.drizzle.test.ts`. Runs against its own
// scratch database.
//
// Proves the CL-7594 rich-part sidecar: `recordMessageParts` persists a
// frame's `Part[]` under its Message-ID, `readMessageParts` returns it,
// `listMessagePartsForFrames` batches one page in one query, a frame with
// no row reads null (the timeline's text-only fallback, never an error),
// a corrupt row likewise reads null, and a second record for the same
// Message-ID is first-write-wins so a retried send never clobbers the
// confirmed parts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { applyChatMigrations } from "../src/migrations";
import {
  createDrizzleMessagePartsStore,
  createInMemoryMessagePartsStore,
  type MessagePartsStore,
} from "../src/message-parts";
import type { Part } from "../src/parts";

const TEXT_PART: Part = {
  kind: "text",
  text: "hello from the native timeline",
};

const BLOCK_PART: Part = {
  kind: "block",
  block: { type: "text", data: { text: "rich" } },
};

function textPart(): Part {
  return { kind: "text", text: "hello from the native timeline" };
}

describe("createInMemoryMessagePartsStore", () => {
  test("records and reads back a frame's parts", async () => {
    const store = createInMemoryMessagePartsStore();
    await store.recordMessageParts({
      tenantId: "ten_1",
      mailMessageId: "<m1@chat>",
      workbenchId: "run_1",
      parts: [textPart()],
    });
    expect(
      await store.readMessageParts("ten_1", "<m1@chat>"),
    ).toEqual([TEXT_PART]);
  });

  test("a frame with no row reads null", async () => {
    const store = createInMemoryMessagePartsStore();
    expect(await store.readMessageParts("ten_1", "<absent@chat>")).toBeNull();
  });

  test("batch read returns only the wanted frames", async () => {
    const store: MessagePartsStore = createInMemoryMessagePartsStore();
    await store.recordMessageParts({
      tenantId: "ten_1",
      mailMessageId: "<m1@chat>",
      workbenchId: "run_1",
      parts: [textPart()],
    });
    await store.recordMessageParts({
      tenantId: "ten_1",
      mailMessageId: "<m2@chat>",
      workbenchId: "run_1",
      parts: [BLOCK_PART],
    });
    const rows = await store.listMessagePartsForFrames("ten_1", [
      "<m1@chat>",
      "<absent@chat>",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].mailMessageId).toBe("<m1@chat>");
    expect(rows[0].parts).toEqual([TEXT_PART]);
    expect(await store.listMessagePartsForFrames("ten_1", [])).toEqual([]);
  });
});

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_message_parts_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("createDrizzleMessagePartsStore", () => {
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
    await applyChatMigrations(scratchUrl);
  });

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

  test("round-trips parts, batches a page, and misses read null", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleMessagePartsStore(drizzle(sql));
      await store.recordMessageParts({
        tenantId: "ten_1",
        mailMessageId: "<m1@chat>",
        workbenchId: "run_1",
        parts: [textPart(), BLOCK_PART],
      });
      expect(await store.readMessageParts("ten_1", "<m1@chat>")).toEqual([
        TEXT_PART,
        BLOCK_PART,
      ]);
      expect(
        await store.readMessageParts("ten_1", "<absent@chat>"),
      ).toBeNull();
      const rows = await store.listMessagePartsForFrames("ten_1", [
        "<m1@chat>",
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].workbenchId).toBe("run_1");
      expect(rows[0].parts).toEqual([TEXT_PART, BLOCK_PART]);
    } finally {
      await sql.end();
    }
  });

  test("a second record for the same Message-ID never clobbers the first", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleMessagePartsStore(drizzle(sql));
      await store.recordMessageParts({
        tenantId: "ten_1",
        mailMessageId: "<retry@chat>",
        workbenchId: "run_1",
        parts: [textPart()],
      });
      await store.recordMessageParts({
        tenantId: "ten_1",
        mailMessageId: "<retry@chat>",
        workbenchId: "run_1",
        parts: [BLOCK_PART],
      });
      expect(await store.readMessageParts("ten_1", "<retry@chat>")).toEqual([
        TEXT_PART,
      ]);
    } finally {
      await sql.end();
    }
  });

  test("a corrupt sidecar row reads null rather than breaking the page", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(
        `INSERT INTO "chat"."message_parts" ("tenant_id", "mail_message_id", "workbench_id", "parts") VALUES ('ten_1', '<corrupt@chat>', 'run_1', '[{"kind": "no-such-part"}]')`,
      );
      const store = createDrizzleMessagePartsStore(drizzle(sql));
      expect(
        await store.readMessageParts("ten_1", "<corrupt@chat>"),
      ).toBeNull();
      expect(
        await store.listMessagePartsForFrames("ten_1", ["<corrupt@chat>"]),
      ).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
