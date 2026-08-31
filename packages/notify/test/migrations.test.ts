// DB-gated: runs against its own scratch database, never the developer's or
// the walking-skeleton suite's, mirroring `packages/schedules/test/migrations.test.ts`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyNotifyMigrations } from "../src/migrations";
import { createDrizzleNotifyDispatchStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_notify_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("applyNotifyMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

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

  const migrationNames = ["0001_notify_dispatch"];

  test("creates the dispatch table in its own schema once and is a no-op on a re-run", async () => {
    const first = await applyNotifyMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);
    const second = await applyNotifyMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'notify' AND table_name = 'notify_dispatch'`,
      );
      expect(tables).toHaveLength(1);

      const inPublic = await sql.unsafe(
        `SELECT 1 FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'notify_dispatch'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("queues one row per sink, dedupes a redelivery, and settles it", async () => {
    await applyNotifyMigrations(scratchUrl);
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleNotifyDispatchStore(drizzle(client));
      const queued = {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "slack",
      };
      await store.enqueue([queued]);
      await store.enqueue([queued]);
      const rows = await store.listFor("mail-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending");
      expect(rows[0]?.id.startsWith("sig_")).toBe(true);

      const due = await store.findDue(new Date(), 10);
      expect(due.map((row) => row.id)).toEqual([rows[0]?.id ?? ""]);

      await store.settle({
        id: rows[0]?.id ?? "",
        status: "delivered",
        attempts: 1,
        lastError: null,
        nextAttemptAt: new Date(),
      });
      expect(await store.findDue(new Date(), 10)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
