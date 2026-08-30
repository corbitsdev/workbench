// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring
// `reactions.drizzle.test.ts`. Runs against its own scratch database.
//
// `threads.test.ts` proves `ensureRootThread`/`openReplyThread`/
// `createDeliveryThread`'s idempotency against the in-memory store,
// which can never actually race (no `await` between its read and
// write). This exercises the real `createDrizzleThreadStore` path,
// where two concurrent first writers for the same root, reply, or
// delivery key really do race at the database: proves the fix (insert
// with `onConflictDoNothing` backed by the partial unique index, then
// re-select on conflict — never select-then-insert) never throws a raw
// unique-violation and both callers converge on the same thread row
// (CL-7130, CL-7199).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleThreadStore } from "../src/threads";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_threads_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";

describeIfDb("createDrizzleThreadStore: concurrent first writers", () => {
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

  test("two concurrent ensureRootThread calls for the same workbench never throw a unique-violation and agree on one row", async () => {
    // `max: 5` — a real connection pool, so the two calls below issue
    // genuinely overlapping queries rather than being serialized onto
    // one connection before either can race the other.
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleThreadStore(drizzle(sql));

      const [first, second] = await Promise.all([
        store.ensureRootThread(TENANT, WORKBENCH),
        store.ensureRootThread(TENANT, WORKBENCH),
      ]);

      expect(first.id).toBe(second.id);

      const rows = await sql.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = $1 AND workbench_id = $2 AND kind = 'root'`,
        [TENANT, WORKBENCH],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("two concurrent openReplyThread calls for the same parent message never throw a unique-violation and agree on one row", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleThreadStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        parentMessageId: "msg_race",
      };

      const [first, second] = await Promise.all([
        store.openReplyThread(input),
        store.openReplyThread(input),
      ]);

      expect(first.id).toBe(second.id);

      const rows = await sql.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = $1 AND workbench_id = $2 AND kind = 'reply' AND parent_message_id = $3`,
        [TENANT, WORKBENCH, "msg_race"],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("two concurrent createDeliveryThread calls for the same run ref never throw a unique-violation and agree on one row", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleThreadStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        runRef: "run_race",
      };

      const [first, second] = await Promise.all([
        store.createDeliveryThread(input),
        store.createDeliveryThread(input),
      ]);

      expect(first.id).toBe(second.id);

      const rows = await sql.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = $1 AND workbench_id = $2 AND kind = 'delivery' AND run_ref = $3`,
        [TENANT, WORKBENCH, "run_race"],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});
