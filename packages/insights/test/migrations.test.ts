// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/chat's migrations test.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyInsightsMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_insights_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const migrationNames = [
  "0001_usage_turn",
  "0002_model_price",
  "0003_move_tables_to_insights_schema",
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
          `('usage_turn', 'model_price')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "model_price",
        "usage_turn",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('usage_turn', 'model_price')`,
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

describeIfDb(
  "applyInsightsMigrations against a pre-existing public-schema install",
  () => {
    const scratchUrl = scratchUrlFor(
      databaseUrl ?? "postgres://localhost:5432/unused",
    ).replace("_insights_migrations_test", "_insights_migrations_move_test");
    const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

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

    test("SET SCHEMA moves pre-existing public usage_turn/model_price tables into their own schema, data intact", async () => {
      const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS "public"."usage_turn" (
            "id" text PRIMARY KEY,
            "tenant_id" text NOT NULL,
            "session_id" text NOT NULL,
            "turn_id" text NOT NULL,
            "model" text NOT NULL,
            "input_tokens" integer NOT NULL DEFAULT 0,
            "cache_read_tokens" integer NOT NULL DEFAULT 0,
            "cache_write_tokens" integer NOT NULL DEFAULT 0,
            "output_tokens" integer NOT NULL DEFAULT 0,
            "thinking_tokens" integer NOT NULL DEFAULT 0,
            "recorded_at" timestamptz NOT NULL DEFAULT now()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS "usage_turn_turn_id_uidx"
            ON "public"."usage_turn" ("turn_id");
          CREATE TABLE IF NOT EXISTS "public"."model_price" (
            "model" text PRIMARY KEY,
            "input_per_m_tok" numeric,
            "output_per_m_tok" numeric,
            "cache_read_per_m_tok" numeric,
            "cache_write_per_m_tok" numeric,
            "thinking_per_m_tok" numeric
          );
        `);
        await sql.unsafe(
          `INSERT INTO "public"."usage_turn" ` +
            `(id, tenant_id, session_id, turn_id, model) ` +
            `VALUES ('utn_pre', 'tnt_pre', 'ses_pre', 'trn_pre', 'claude-sonnet')`,
        );
        await sql.unsafe(
          `CREATE TABLE IF NOT EXISTS "public"."insights_migrations" (` +
            `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        await sql.unsafe(
          `INSERT INTO "public"."insights_migrations" (name) VALUES ` +
            `('0001_usage_turn'), ('0002_model_price')`,
        );
      } finally {
        await sql.end();
      }

      const report = await applyInsightsMigrations(scratchUrl);
      expect(report.applied).toEqual(["0003_move_tables_to_insights_schema"]);

      const sql2 = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        const inPublic = await sql2.unsafe(
          `SELECT table_name FROM information_schema.tables ` +
            `WHERE table_schema = 'public' AND table_name IN ` +
            `('usage_turn', 'model_price')`,
        );
        expect(inPublic).toHaveLength(0);

        const rows = await sql2.unsafe(
          `SELECT id, turn_id FROM "insights"."usage_turn"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.["id"]).toBe("utn_pre");
      } finally {
        await sql2.end();
      }
    });
  },
);
