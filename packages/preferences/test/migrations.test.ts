// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/insights' migrations test.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyPreferencesMigrations } from "../src/migrations";
import { createPostgresPreferencesStore } from "../src/pg-store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_preferences_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const migrationNames = ["0001_user_preferences"];

describeIfDb("applyPreferencesMigrations", () => {
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

  test("applies the table into its own schema and is idempotent on a second run", async () => {
    const first = await applyPreferencesMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyPreferencesMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'preferences' AND table_name = 'user_preferences'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "user_preferences",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'user_preferences'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("get/patch round-trip through the real Postgres-backed store", async () => {
    const { store, close } = createPostgresPreferencesStore(scratchUrl);
    try {
      expect(await store.getPreferences("tnt_1", "prn_1")).toEqual({});

      const merged1 = await store.patchPreferences("tnt_1", "prn_1", {
        "shell.col2Collapsed": true,
      });
      expect(merged1).toEqual({ "shell.col2Collapsed": true });

      const merged2 = await store.patchPreferences("tnt_1", "prn_1", {
        "shell.theme": "dark",
      });
      expect(merged2).toEqual({
        "shell.col2Collapsed": true,
        "shell.theme": "dark",
      });

      expect(await store.getPreferences("tnt_1", "prn_1")).toEqual({
        "shell.col2Collapsed": true,
        "shell.theme": "dark",
      });

      expect(await store.getPreferences("tnt_1", "prn_2")).toEqual({});
    } finally {
      await close();
    }
  });
});
