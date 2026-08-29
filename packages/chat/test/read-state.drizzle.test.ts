// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring `migrations.test.ts`.
// Runs against its own scratch database.
//
// `store.test.ts` proves `putReadState`'s monotonicity guard against
// the in-memory store. This exercises the real `createDrizzleChatStore`
// path, where the guard is a conditional `ON CONFLICT DO UPDATE ... SET`
// rather than an in-process comparison — proving the SQL itself never
// regresses a reader's cursor.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleChatStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_read_state_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";
const PRINCIPAL = "prn_alice";

describeIfDb("createDrizzleChatStore: putReadState monotonicity", () => {
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

  test("a stale write landing after a newer one never moves the cursor backward", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));

      await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: PRINCIPAL,
        lastSeenCreatedAt: new Date("2026-01-02T00:00:00.000Z"),
        lastSeenId: "mail_2",
      });

      const result = await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: PRINCIPAL,
        lastSeenCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastSeenId: "mail_1",
      });

      expect(result.lastSeenId).toBe("mail_2");
      expect(result.lastSeenCreatedAt).toEqual(
        new Date("2026-01-02T00:00:00.000Z"),
      );

      const stored = await store.getReadState(TENANT, WORKBENCH, PRINCIPAL);
      expect(stored?.lastSeenId).toBe("mail_2");
    } finally {
      await sql.end();
    }
  });

  test("a newer write still moves the cursor forward", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));

      await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: "prn_bob",
        lastSeenCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastSeenId: "mail_1",
      });

      const result = await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: "prn_bob",
        lastSeenCreatedAt: new Date("2026-01-03T00:00:00.000Z"),
        lastSeenId: "mail_3",
      });

      expect(result.lastSeenId).toBe("mail_3");

      const stored = await store.getReadState(TENANT, WORKBENCH, "prn_bob");
      expect(stored?.lastSeenId).toBe("mail_3");
    } finally {
      await sql.end();
    }
  });

  test("a same-millisecond forward move to a different message still lands", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));
      const sameCreatedAt = new Date("2026-01-04T00:00:00.001Z");

      await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: "prn_carol",
        lastSeenCreatedAt: sameCreatedAt,
        lastSeenId: "mail_4",
      });

      const result = await store.putReadState({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        principalId: "prn_carol",
        lastSeenCreatedAt: sameCreatedAt,
        lastSeenId: "mail_5",
      });

      expect(result.lastSeenId).toBe("mail_5");

      const stored = await store.getReadState(TENANT, WORKBENCH, "prn_carol");
      expect(stored?.lastSeenId).toBe("mail_5");
    } finally {
      await sql.end();
    }
  });
});
