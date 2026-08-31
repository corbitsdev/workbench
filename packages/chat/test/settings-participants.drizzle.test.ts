// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `read-state.drizzle.test.ts`.
// Runs against its own scratch database.
//
// CL-7194: `store.ts`'s `updateWorkbenchSettings` used to be the only way
// to add or remove a workbench participant — a blind whole-blob
// `UPDATE ... SET settings = $1` with no lock and no version guard. Two
// concurrent invites each read their own stale snapshot, computed a full
// settings object from it, and wrote the whole thing back; the second
// write silently discarded the first's participant. `mutateWorkbenchParticipants`
// closes that by taking a `SELECT ... FOR UPDATE` row lock and writing back
// only the `chat/participants` path inside the same transaction, so two
// overlapping calls serialize instead of clobbering each other. This test
// fires two real concurrent transactions (two connections from the pool)
// at the same row and proves both participants land.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { addParticipant } from "../src/participants";
import { createDrizzleChatStore } from "../src/store";
import { participantsOf } from "../src/workbench-settings";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_settings_participants_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT = "tnt_1";

describeIfDb("createDrizzleChatStore: mutateWorkbenchParticipants", () => {
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

  test("two concurrent invites to the same workbench both survive", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));
      const workbenchId = "run_concurrent_invite";
      await store.createWorkbenchSettings({
        tenantId: TENANT,
        workbenchId,
        settings: { "chat/kind": "workbench" },
        updatedBy: "prn_owner",
      });

      // Two overlapping invites, exactly the failure scenario in
      // CL-7194: fired together, not awaited one after the other, each
      // over its own pool connection.
      await Promise.all([
        store.mutateWorkbenchParticipants({
          tenantId: TENANT,
          workbenchId,
          updatedBy: "prn_alice",
          mutate: (participants) =>
            addParticipant(participants, "prn_bob", "bob"),
        }),
        store.mutateWorkbenchParticipants({
          tenantId: TENANT,
          workbenchId,
          updatedBy: "prn_carol",
          mutate: (participants) =>
            addParticipant(participants, "prn_dave", "dave"),
        }),
      ]);

      const row = await store.getWorkbenchSettings(TENANT, workbenchId);
      const addresses = participantsOf(row?.settings ?? {})
        .map((participant) => participant.address)
        .sort();
      expect(addresses).toEqual(["prn_bob", "prn_dave"]);
      // The untouched key from the original row is still there — proof
      // the write is a targeted `chat/participants` merge, not a
      // whole-blob replace that happened to preserve it by luck.
      expect(row?.settings["chat/kind"]).toBe("workbench");
    } finally {
      await sql.end();
    }
  });

  test("a removal racing an addition leaves exactly the surviving participant", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleChatStore(drizzle(sql));
      const workbenchId = "run_concurrent_remove_add";
      await store.createWorkbenchSettings({
        tenantId: TENANT,
        workbenchId,
        settings: {
          "chat/kind": "workbench",
          "chat/participants": [{ address: "prn_bob", handle: "bob" }],
        },
        updatedBy: "prn_owner",
      });

      await Promise.all([
        store.mutateWorkbenchParticipants({
          tenantId: TENANT,
          workbenchId,
          updatedBy: "prn_alice",
          mutate: (participants) =>
            participants.filter(
              (participant) => participant.address !== "prn_bob",
            ),
        }),
        store.mutateWorkbenchParticipants({
          tenantId: TENANT,
          workbenchId,
          updatedBy: "prn_carol",
          mutate: (participants) =>
            addParticipant(participants, "prn_dave", "dave"),
        }),
      ]);

      const row = await store.getWorkbenchSettings(TENANT, workbenchId);
      const addresses = participantsOf(row?.settings ?? {})
        .map((participant) => participant.address)
        .sort();
      expect(addresses).toEqual(["prn_dave"]);
    } finally {
      await sql.end();
    }
  });
});
