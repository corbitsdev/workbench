// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), and turned into a loud failure
// by E2E_REQUIRED=1 so the suite can never silently vanish from CI —
// mirroring scripts/e2e/harness.ts's e2eDatabaseUrl/baseUrlToE2eUrl.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's, so a failure here can never corrupt either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("applyChatMigrations", () => {
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

  test("applies both tables and is idempotent on a second run", async () => {
    const first = await applyChatMigrations(scratchUrl);
    expect(first.applied).toEqual([
      "0001_channel_settings",
      "0002_channel_read_state",
      "0003_channel_launch",
      "0004_channel_launch_noop_inference",
    ]);

    const second = await applyChatMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([
      "0001_channel_settings",
      "0002_channel_read_state",
      "0003_channel_launch",
      "0004_channel_launch_noop_inference",
    ]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('channel_settings', 'channel_read_state', 'channel_launch')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "channel_launch",
        "channel_read_state",
        "channel_settings",
      ]);
    } finally {
      await sql.end();
    }
  });
});
