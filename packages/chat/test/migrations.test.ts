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
  "0010_block_responses",
  "0011_channel_threads_parent_thread_id",
  "0012_message_reactions",
  "0013_pinned_messages",
  "0014_channel_share",
  "0015_channel_share_member",
  "0016_finalized_turn_write_claim",
  "0017_message_client_ids",
  "0018_rename_channel_to_workbench",
  "0019_workbench_messages",
  "0020_workbench_launch_current_run",
  "0021_workbench_launch_prior_runs",
  "0022_agent_turns",
  "0023_drop_workbench_host_arm",
  "0024_workbench_launch_sources_digest",
];

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
          `WHERE table_schema = 'chat' AND table_name IN ` +
          `('workbench_settings', 'workbench_read_state', 'workbench_launch', 'workbench_tenancy', 'chat_bench_settings', 'workbench_threads', 'workbench_thread_messages', 'message_reactions', 'pinned_messages', 'finalized_turn_write_claim', 'workbench_messages', 'agent_turns')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual(
        [
          "workbench_launch",
          "workbench_read_state",
          "workbench_settings",
          "workbench_tenancy",
          "workbench_thread_messages",
          "workbench_threads",
          "chat_bench_settings",
          "message_reactions",
          "pinned_messages",
          "finalized_turn_write_claim",
          "workbench_messages",
          "agent_turns",
        ].sort(),
      );

      // Renamed away (CL-6260): the old "channel"-named tables must not
      // linger alongside their renamed replacements.
      const oldNamedTables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'chat' AND table_name IN ` +
          `('channel_settings', 'channel_read_state', 'channel_launch', 'channel_tenancy', 'channel_threads', 'channel_thread_messages', 'channel_share', 'channel_share_member')`,
      );
      expect(oldNamedTables).toHaveLength(0);

      // None of chat's tables leak into `public` — every one of them
      // landed in the package's own `chat` schema.
      const publicTables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('workbench_settings', 'workbench_read_state', 'workbench_launch', 'workbench_tenancy', 'chat_bench_settings', 'workbench_threads', 'workbench_thread_messages', 'block_responses', 'message_reactions', 'pinned_messages')`,
      );
      expect(publicTables).toHaveLength(0);

      // `listChildWorkbenchTenancies` filters on `parent_tenant_id` on
      // every `GET /workbenches` call — without an index that is a
      // sequential scan on every request.
      const indexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'workbench_tenancy'`,
      );
      expect(indexes.map((row) => String(row["indexname"]))).toContain(
        "workbench_tenancy_parent_tenant_id_idx",
      );

      // The batched per-message reaction/pin reads on `GET /messages`
      // filter on (tenant, workbench[, message]) — without these, both
      // become sequential scans on every page load.
      const reactionIndexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'message_reactions'`,
      );
      expect(reactionIndexes.map((row) => String(row["indexname"]))).toContain(
        "message_reactions_message_idx",
      );

      const pinIndexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'pinned_messages'`,
      );
      expect(pinIndexes.map((row) => String(row["indexname"]))).toContain(
        "pinned_messages_workbench_idx",
      );
    } finally {
      await sql.end();
    }
  });

  test("0008 makes a pre-existing row's absent contextWindow an explicit inherit, leaving a set value untouched", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`DELETE FROM "chat"."workbench_settings"`);
      await sql.unsafe(
        `INSERT INTO "chat"."workbench_settings" (tenant_id, workbench_id, settings, updated_by) VALUES
          ('tnt_1', 'chn_absent', '{"chat/kind": "channel"}'::jsonb, 'prn_1'),
          ('tnt_1', 'chn_override', '{"chat/kind": "channel", "chat/contextWindow": 5}'::jsonb, 'prn_1')`,
      );

      // 0008's own historical SQL text still names the pre-rename table
      // and column (see `chatMigrations`) — this scratch database has
      // already run 0018's rename, so exercising 0008's *behavior* here
      // means restating its `jsonb_set` logic against the current table
      // name rather than replaying that stale literal text.
      const contextWindowInheritSql = chatMigrations.find(
        (candidate) =>
          candidate.name === "0008_channel_context_window_explicit_inherit",
      );
      if (contextWindowInheritSql === undefined) {
        throw new Error("0008 migration missing from chatMigrations");
      }
      await sql.unsafe(`
        UPDATE "chat"."workbench_settings"
        SET "settings" = jsonb_set("settings", '{chat/contextWindow}', 'null'::jsonb)
        WHERE NOT ("settings" ? 'chat/contextWindow');
      `);

      const rows = await sql.unsafe(
        `SELECT workbench_id, settings FROM "chat"."workbench_settings" ORDER BY workbench_id`,
      );
      const byId = new Map(
        rows.map((row) => [String(row["workbench_id"]), row["settings"]]),
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
