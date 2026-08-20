// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/routines' own
// store.drizzle.test.ts. `store.test.ts` proves the in-memory store's
// contract; this exercises the real `createDrizzleConfigProfileStore`
// path against Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyConfigProfilesMigrations } from "../src/migrations";
import { createDrizzleConfigProfileStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_config_profiles_store_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT_ID = "tnt_workspace";

describeIfDb("createDrizzleConfigProfileStore", () => {
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
    await applyConfigProfilesMigrations(scratchUrl);
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

  test("create/get/list/update/delete round-trips through real Postgres", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleConfigProfileStore(drizzle(sql));

      const created = await store.createProfile({
        tenantId: TENANT_ID,
        name: "Fast & cheap",
        description: "for quick tasks",
        entries: [
          { provider: "OpenAI", model: "gpt-5" },
          { provider: "Anthropic", model: "claude", disabled: true },
        ],
        createdBy: "prn_1",
      });
      expect(created.name).toBe("Fast & cheap");
      expect(created.entries).toHaveLength(2);

      const fetched = await store.getProfile(TENANT_ID, created.id);
      expect(fetched?.entries).toEqual(created.entries);

      const listed = await store.listProfiles(TENANT_ID);
      expect(listed.map((row) => row.id)).toContain(created.id);

      const updated = await store.updateProfile(TENANT_ID, created.id, {
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
      expect(updated.entries).toEqual(created.entries);

      const deleted = await store.deleteProfile(TENANT_ID, created.id);
      expect(deleted).toBe(true);
      expect(await store.getProfile(TENANT_ID, created.id)).toBeUndefined();
    } finally {
      await sql.end();
    }
  });

  test("rows are isolated by tenant_id", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleConfigProfileStore(drizzle(sql));
      await store.createProfile({
        tenantId: TENANT_ID,
        name: "A",
        entries: [],
        createdBy: "prn_1",
      });
      const otherTenant = await store.listProfiles("tnt_other");
      expect(otherTenant).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
