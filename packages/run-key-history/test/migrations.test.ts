// DB-gated: runs against its own scratch database, never the
// developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRunKeyHistoryMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_run_key_history_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("applyRunKeyHistoryMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(run: (sql: postgres.Sql) => Promise<void>) {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
  }, 20000);

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  }, 20000);

  test("creates the run_key_history schema and table", async () => {
    const report = await applyRunKeyHistoryMigrations(scratchUrl);
    expect(report.applied).toEqual(["0001_run_key_history"]);

    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const inSchema = await client.unsafe(
        `SELECT 1 FROM information_schema.tables ` +
          `WHERE table_schema = 'run_key_history' AND table_name = 'run_key_history'`,
      );
      expect(inSchema).toHaveLength(1);
    } finally {
      await client.end();
    }
  }, 30000);

  test("re-running the migration is a no-op", async () => {
    const second = await applyRunKeyHistoryMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain("0001_run_key_history");
  }, 20000);
});
