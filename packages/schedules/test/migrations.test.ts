// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates). Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's, so
// a failure here can never corrupt either — mirroring
// `packages/chat/test/migrations.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyScheduleMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_schedules_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("applyScheduleMigrations", () => {
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

  test("applies the schedules table and is idempotent on a second run", async () => {
    const first = await applyScheduleMigrations(scratchUrl);
    expect(first.applied).toEqual([
      "0001_schedules",
      "0002_schedules_due_index",
    ]);

    const second = await applyScheduleMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([
      "0001_schedules",
      "0002_schedules_due_index",
    ]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'schedules'`,
      );
      expect(tables.map((row) => String(row["table_name"]))).toEqual([
        "schedules",
      ]);
    } finally {
      await sql.end();
    }
  });
});
