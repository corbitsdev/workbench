// DB-gated: proves `recordObservedKey`'s append-only supersession
// semantics against a real Postgres transaction, using the same
// scratch-database setup pattern every DB-gated suite in this repo
// uses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRunKeyHistoryMigrations } from "../src/migrations";
import { createDrizzleRunKeyHistoryStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_run_key_history_store_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("createDrizzleRunKeyHistoryStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(run: (sql: postgres.Sql) => Promise<void>) {
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
    await applyRunKeyHistoryMigrations(scratchUrl);
  }, 20000);

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("first ack for a run creates one current-entry row", async () => {
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleRunKeyHistoryStore(drizzle(client));
      await store.recordObservedKey("run_1@ten1.workbench.test", "key-a");

      const rows = await client.unsafe(
        `SELECT public_key, superseded_at FROM run_key_history.run_key_history WHERE run_address = $1`,
        ["run_1@ten1.workbench.test"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["public_key"]).toBe("key-a");
      expect(rows[0]?.["superseded_at"]).toBeNull();
    } finally {
      await client.end();
    }
  }, 20000);

  test("an ack with an unchanged key is a no-op", async () => {
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleRunKeyHistoryStore(drizzle(client));
      await store.recordObservedKey("run_2@ten1.workbench.test", "key-a");
      await store.recordObservedKey("run_2@ten1.workbench.test", "key-a");

      const rows = await client.unsafe(
        `SELECT public_key FROM run_key_history.run_key_history WHERE run_address = $1`,
        ["run_2@ten1.workbench.test"],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  }, 20000);

  test("an ack with a changed key supersedes the old row and inserts a new current row", async () => {
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleRunKeyHistoryStore(drizzle(client));
      await store.recordObservedKey("run_3@ten1.workbench.test", "key-a");
      await store.recordObservedKey("run_3@ten1.workbench.test", "key-b");

      const rows = await client.unsafe(
        `SELECT public_key, recorded_at, superseded_at FROM run_key_history.run_key_history ` +
          `WHERE run_address = $1 ORDER BY recorded_at ASC`,
        ["run_3@ten1.workbench.test"],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.["public_key"]).toBe("key-a");
      expect(rows[0]?.["superseded_at"]).not.toBeNull();
      expect(rows[1]?.["public_key"]).toBe("key-b");
      expect(rows[1]?.["superseded_at"]).toBeNull();

      const current = await store.getCurrent("run_3@ten1.workbench.test");
      expect(current?.publicKey).toBe("key-b");
    } finally {
      await client.end();
    }
  }, 20000);

  test("two acks with different keys leave exactly one current row and a sensible ordering", async () => {
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleRunKeyHistoryStore(drizzle(client));
      await store.recordObservedKey("run_4@ten1.workbench.test", "key-a");
      await store.recordObservedKey("run_4@ten1.workbench.test", "key-b");
      await store.recordObservedKey("run_4@ten1.workbench.test", "key-c");

      const rows = await client.unsafe(
        `SELECT public_key, recorded_at, superseded_at FROM run_key_history.run_key_history ` +
          `WHERE run_address = $1 ORDER BY recorded_at ASC`,
        ["run_4@ten1.workbench.test"],
      );
      expect(rows).toHaveLength(3);

      const currentRows = rows.filter((row) => row["superseded_at"] === null);
      expect(currentRows).toHaveLength(1);
      expect(currentRows[0]?.["public_key"]).toBe("key-c");

      // Every superseded row's own supersededAt is at or after its
      // recordedAt, and at or before the next row's recordedAt --
      // supersession never lands before the record it closes out, nor
      // after the row that replaces it.
      for (let i = 0; i < rows.length - 1; i++) {
        const row = rows[i];
        const next = rows[i + 1];
        if (row === undefined || next === undefined) continue;
        const recordedAt = new Date(row["recorded_at"] as string).getTime();
        const supersededAt = new Date(row["superseded_at"] as string).getTime();
        const nextRecordedAt = new Date(
          next["recorded_at"] as string,
        ).getTime();
        expect(supersededAt).toBeGreaterThanOrEqual(recordedAt);
        expect(supersededAt).toBeLessThanOrEqual(nextRecordedAt);
      }
    } finally {
      await client.end();
    }
  }, 20000);
});
