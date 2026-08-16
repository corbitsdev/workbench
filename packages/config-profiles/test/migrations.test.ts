// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/preferences' own
// migrations test. Runs against its own scratch database, never the
// developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyConfigProfilesMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_config_profiles_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const migrationNames = ["0001_profile"];

describeIfDb("applyConfigProfilesMigrations", () => {
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
    const first = await applyConfigProfilesMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyConfigProfilesMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'config_profiles' AND table_name = 'profile'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "profile",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'profile'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
