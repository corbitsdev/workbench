// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/insights' migrations
// test. Runs against its own scratch database, never the developer's
// or the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyOnboardingMigrations } from "../src/migrations";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_onboarding_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const migrationNames = ["0001_pending_seed"];

describeIfDb("applyOnboardingMigrations", () => {
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

  test("applies the pending_seed table into its own schema and is idempotent on a second run", async () => {
    const first = await applyOnboardingMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyOnboardingMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(migrationNames);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'onboarding' AND table_name = 'pending_seed'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "pending_seed",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'pending_seed'`,
      );
      expect(inPublic).toHaveLength(0);

      const primaryKeyColumns = await sql.unsafe(
        `SELECT a.attname FROM pg_index i ` +
          `JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) ` +
          `WHERE i.indrelid = 'onboarding.pending_seed'::regclass AND i.indisprimary`,
      );
      expect(
        primaryKeyColumns.map((row) => String(row["attname"])).sort(),
      ).toEqual(["tenant_id", "user_id"]);
    } finally {
      await sql.end();
    }
  });
});
