// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/chat's migrations test.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyInsightsMigrations } from "../src/migrations";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_insights_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const migrationNames = [
  "0001_usage_turn",
  "0002_model_price",
  "0003_turn_latency",
  "0004_usage_turn_provider_cost",
];

describeIfDb("applyInsightsMigrations", () => {
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

  test("applies both tables into their own schema and is idempotent on a second run", async () => {
    const first = await applyInsightsMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyInsightsMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'insights' AND table_name IN ` +
          `('usage_turn', 'model_price', 'turn_latency')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "model_price",
        "turn_latency",
        "usage_turn",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('usage_turn', 'model_price', 'turn_latency')`,
      );
      expect(inPublic).toHaveLength(0);

      const indexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'insights' AND tablename = 'usage_turn'`,
      );
      expect(indexes.map((row) => String(row["indexname"]))).toContain(
        "usage_turn_turn_id_uidx",
      );
    } finally {
      await sql.end();
    }
  });
});
