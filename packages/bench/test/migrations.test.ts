// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/preferences' migrations
// test. Runs against its own scratch database, never the developer's or
// the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyBenchMigrations } from "../src/migrations";
import { createPostgresBenchSettingsStore } from "../src/pg-store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_bench_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const migrationNames = ["0001_bench_settings"];

describeIfDb("applyBenchMigrations", () => {
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
    const first = await applyBenchMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyBenchMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'bench' AND table_name = 'bench_settings'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "bench_settings",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'bench_settings'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  test("get/patch round-trip through the real Postgres-backed store", async () => {
    const { store, close } = createPostgresBenchSettingsStore(scratchUrl);
    try {
      const initial = await store.getBenchSettings("tnt_1");
      expect(initial.purpose).toBeNull();
      expect(initial.type).toBeNull();

      const merged1 = await store.patchBenchSettings("tnt_1", {
        purpose: "Launch planning",
      });
      expect(merged1.purpose).toBe("Launch planning");
      expect(merged1.type).toBeNull();

      const merged2 = await store.patchBenchSettings("tnt_1", {
        type: "global",
      });
      expect(merged2.purpose).toBe("Launch planning");
      expect(merged2.type).toBe("global");

      const read = await store.getBenchSettings("tnt_1");
      expect(read.purpose).toBe("Launch planning");
      expect(read.type).toBe("global");

      const other = await store.getBenchSettings("tnt_2");
      expect(other.purpose).toBeNull();
    } finally {
      await close();
    }
  });
});
