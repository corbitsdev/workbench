// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), and turned into a loud failure
// by E2E_REQUIRED=1 so the suite can never silently vanish from CI —
// mirroring scripts/e2e/harness.ts's e2eDatabaseUrl/baseUrlToE2eUrl.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's, so a failure here can never corrupt either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations, chatMigrations } from "../src/migrations";

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

  const migrationNames = [
    "0001_channel_settings",
    "0002_channel_read_state",
    "0003_channel_launch",
    "0004_channel_launch_noop_inference",
    "0005_channel_tenancy",
    "0006_channel_tenancy_parent_index",
    "0007_chat_bench_settings",
    "0008_channel_context_window_explicit_inherit",
    "0009_channel_threads",
  ];

  test("applies every table and is idempotent on a second run", async () => {
    const first = await applyChatMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyChatMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('channel_settings', 'channel_read_state', 'channel_launch', 'channel_tenancy', 'chat_bench_settings', 'channel_threads', 'channel_thread_messages')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual(
        [
          "channel_launch",
          "channel_read_state",
          "channel_settings",
          "channel_tenancy",
          "channel_thread_messages",
          "channel_threads",
          "chat_bench_settings",
        ].sort(),
      );

      // `listChildChannelTenancies` filters on `parent_tenant_id` on
      // every `GET /channels` call — without an index that is a
      // sequential scan on every request.
      const indexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'channel_tenancy'`,
      );
      expect(indexes.map((row) => String(row["indexname"]))).toContain(
        "channel_tenancy_parent_tenant_id_idx",
      );
    } finally {
      await sql.end();
    }
  });

  test("0008 makes a pre-existing row's absent contextWindow an explicit inherit, leaving a set value untouched", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`DELETE FROM "channel_settings"`);
      await sql.unsafe(
        `INSERT INTO "channel_settings" (tenant_id, channel_id, settings, updated_by) VALUES
          ('tnt_1', 'chn_absent', '{"chat/kind": "channel"}'::jsonb, 'prn_1'),
          ('tnt_1', 'chn_override', '{"chat/kind": "channel", "chat/contextWindow": 5}'::jsonb, 'prn_1')`,
      );

      // Re-runs 0008's own SQL directly (rather than `applyChatMigrations`,
      // whose ledger already marked 0008 applied by the earlier test) to
      // exercise its behavior against rows inserted after that first run.
      const migration = chatMigrations.find(
        (candidate) =>
          candidate.name === "0008_channel_context_window_explicit_inherit",
      );
      if (migration === undefined) {
        throw new Error("0008 migration missing from chatMigrations");
      }
      await sql.unsafe(migration.sql);

      const rows = await sql.unsafe(
        `SELECT channel_id, settings FROM "channel_settings" ORDER BY channel_id`,
      );
      const byId = new Map(
        rows.map((row) => [String(row["channel_id"]), row["settings"]]),
      );
      expect(
        (byId.get("chn_absent") as Record<string, unknown>)[
          "chat/contextWindow"
        ],
      ).toBeNull();
      expect(
        (byId.get("chn_override") as Record<string, unknown>)[
          "chat/contextWindow"
        ],
      ).toBe(5);
    } finally {
      await sql.end();
    }
  });
});
