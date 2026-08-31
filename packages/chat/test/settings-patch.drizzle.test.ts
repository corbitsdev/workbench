// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring `read-state.drizzle.test.ts`.
// Two concurrent `patchWorkbenchSettings` calls on one row must both land:
// a participants write and a `chat/pinned` write cannot clobber each other.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleChatStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_settings_patch_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";
const ALICE = { address: "prn_alice@acme.example", handle: "alice" };
const BOB = { address: "prn_bob@acme.example", handle: "bob" };

describeIfDb("createDrizzleChatStore: patchWorkbenchSettings", () => {
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

  test("concurrent patches of participants and another key both land", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));
      await store.createWorkbenchSettings({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        settings: {
          "chat/pinned": false,
          "chat/participants": [ALICE],
        },
        updatedBy: "prn_1",
      });

      await Promise.all([
        store.patchWorkbenchSettings({
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          patch: { "chat/pinned": true },
          updatedBy: "prn_2",
        }),
        store.patchWorkbenchSettings({
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          patch: { "chat/participants": [ALICE, BOB] },
          updatedBy: "prn_3",
        }),
      ]);

      const row = await store.getWorkbenchSettings(TENANT, WORKBENCH);
      expect(row?.settings["chat/pinned"]).toBe(true);
      expect(row?.settings["chat/participants"]).toEqual([ALICE, BOB]);
    } finally {
      await sql.end();
    }
  });

  test("a patch that omits chat/participants keeps the locked row's list", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));
      const workbenchId = "run_workbench2";
      await store.createWorkbenchSettings({
        tenantId: TENANT,
        workbenchId,
        settings: {
          "chat/pinned": false,
          "chat/participants": [ALICE, BOB],
        },
        updatedBy: "prn_1",
      });

      const updated = await store.patchWorkbenchSettings({
        tenantId: TENANT,
        workbenchId,
        patch: { "chat/pinned": true },
        updatedBy: "prn_2",
      });
      expect(updated.settings["chat/pinned"]).toBe(true);
      expect(updated.settings["chat/participants"]).toEqual([ALICE, BOB]);
    } finally {
      await sql.end();
    }
  });
});
