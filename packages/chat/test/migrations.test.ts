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
  "0012_move_tables_to_chat_schema",
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

      // None of chat's tables leak into `public` — every one of them
      // landed in the package's own `chat` schema.
      const publicTables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('channel_settings', 'channel_read_state', 'channel_launch', 'channel_tenancy', 'chat_bench_settings', 'channel_threads', 'channel_thread_messages', 'block_responses')`,
      );
      expect(publicTables).toHaveLength(0);

      // `listChildChannelTenancies` filters on `parent_tenant_id` on
      // every `GET /channels` call — without an index that is a
      // sequential scan on every request.
      const indexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'channel_tenancy'`,
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
      await sql.unsafe(`DELETE FROM "chat"."channel_settings"`);
      await sql.unsafe(
        `INSERT INTO "chat"."channel_settings" (tenant_id, channel_id, settings, updated_by) VALUES
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
        `SELECT channel_id, settings FROM "chat"."channel_settings" ORDER BY channel_id`,
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

describeIfDb(
  "applyChatMigrations against a pre-existing public-schema install",
  () => {
    const scratchUrl = scratchUrlFor(
      databaseUrl ?? "postgres://localhost:5432/unused",
    ).replace("_chat_migrations_test", "_chat_migrations_move_test");
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
      } finally {
        await maintenance.end();
      }
    }, 20000);

    test("SET SCHEMA moves a table that pre-dates the chat schema into it, data intact", async () => {
      // Simulates a dev DB migrated before this package had its own
      // schema: `channel_settings` already exists in `public` with a real
      // row in it, and the ledger (also still in `public`) already has
      // every migration up through 0011 recorded — exactly the state a
      // database sits in the moment before this cutover ships. Only the
      // new 0012 move migration should have anything left to do.
      const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS "public"."channel_settings" (
          "tenant_id" text NOT NULL,
          "channel_id" text NOT NULL,
          "settings" jsonb NOT NULL,
          "updated_by" text NOT NULL,
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY ("tenant_id", "channel_id")
        );
      `);
        await sql.unsafe(
          `INSERT INTO "public"."channel_settings" (tenant_id, channel_id, settings, updated_by) ` +
            `VALUES ('tnt_pre', 'chn_pre', '{"chat/kind": "channel"}'::jsonb, 'prn_pre')`,
        );
        await sql.unsafe(
          `CREATE TABLE IF NOT EXISTS "public"."chat_migrations" (` +
            `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const preExisting = migrationNames.filter(
          (name) => name !== "0012_move_tables_to_chat_schema",
        );
        for (const name of preExisting) {
          await sql.unsafe(
            `INSERT INTO "public"."chat_migrations" (name) VALUES ($1)`,
            [name],
          );
        }
      } finally {
        await sql.end();
      }

      const report = await applyChatMigrations(scratchUrl);
      expect(report.applied).toEqual(["0012_move_tables_to_chat_schema"]);

      const sql2 = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        const inPublic = await sql2.unsafe(
          `SELECT 1 FROM information_schema.tables ` +
            `WHERE table_schema = 'public' AND table_name = 'channel_settings'`,
        );
        expect(inPublic).toHaveLength(0);

        const rows = await sql2.unsafe(
          `SELECT tenant_id, channel_id, settings FROM "chat"."channel_settings"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.["tenant_id"]).toBe("tnt_pre");
        expect(rows[0]?.["channel_id"]).toBe("chn_pre");

        // The ledger itself moved out of `public` too, carrying its
        // history (every pre-existing migration name) with it.
        const ledgerInPublic = await sql2.unsafe(
          `SELECT 1 FROM information_schema.tables ` +
            `WHERE table_schema = 'public' AND table_name = 'chat_migrations'`,
        );
        expect(ledgerInPublic).toHaveLength(0);
        const ledgerRows = await sql2.unsafe(
          `SELECT name FROM "chat"."chat_migrations"`,
        );
        expect(ledgerRows.map((row) => String(row["name"])).sort()).toEqual(
          [...migrationNames].sort(),
        );
      } finally {
        await sql2.end();
      }
    });
  },
);
