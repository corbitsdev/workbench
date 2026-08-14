// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring
// @corbits/chat's `migrations.test.ts`. Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRoutineMigrations } from "../src/migrations";
import { createDrizzleRoutineStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_routine_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

describeIfDb("applyRoutineMigrations", () => {
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

  // Deliberately agnostic to how many migration steps exist or what
  // they're named — this proves the schema and the idempotency
  // contract, not a specific migration sequence, so it stays true
  // whether the package ships one migration or many.
  test("applies every table into its own schema in final shape and is idempotent on a second run", async () => {
    const first = await applyRoutineMigrations(scratchUrl);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = await applyRoutineMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual(first.applied.sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'routines' AND table_name IN ` +
          `('routine', 'routine_run', 'routine_draft')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "routine",
        "routine_draft",
        "routine_run",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('routine', 'routine_run', 'routine_draft')`,
      );
      expect(inPublic).toHaveLength(0);

      const columns = await sql.unsafe(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = 'routines' AND table_name = 'routine'`,
      );
      const columnNames = columns.map((row) => String(row["column_name"]));
      expect(columnNames).toContain("next_fire_at");
      expect(columnNames).toContain("last_fire_at");
      expect(columnNames).toContain("deleted_at");
    } finally {
      await sql.end();
    }
  });

  test("a routine created on a freshly migrated database ends up fireable", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRoutineStore(db);
      const routine = await store.createRoutine({
        tenantId: "tnt_1",
        name: "Hourly",
        definitionId: "def_1",
        trigger: { kind: "interval", unit: "hours", every: 1 },
        scope: "bench",
        input: {},
        createdBy: "user_1",
      });

      expect(routine.nextFireAt).not.toBeNull();
      const due = await store.listDueRoutines(
        new Date((routine.nextFireAt as Date).getTime() + 1),
      );
      expect(due.map((row) => row.id)).toContain(routine.id);
    } finally {
      await sql.end();
    }
  });
});

describeIfDb(
  "applyRoutineMigrations against a pre-existing public-schema install",
  () => {
    const scratchUrl = scratchUrlFor(
      databaseUrl ?? "postgres://localhost:5432/unused",
    ).replace("_routine_migrations_test", "_routine_migrations_move_test");
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

    test("SET SCHEMA moves a pre-existing public routine table into its own schema, data intact", async () => {
      const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS "public"."routine" (
            "id" text PRIMARY KEY,
            "tenant_id" text NOT NULL,
            "name" text NOT NULL,
            "definition_id" text NOT NULL,
            "trigger" jsonb,
            "scope" text NOT NULL,
            "input" jsonb NOT NULL,
            "enabled" boolean NOT NULL DEFAULT true,
            "delivery_channel_id" text,
            "created_by" text NOT NULL,
            "next_fire_at" timestamptz,
            "last_fire_at" timestamptz,
            "deleted_at" timestamptz,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS "public"."routine_run" (
            "tenant_id" text NOT NULL,
            "routine_id" text NOT NULL,
            "run_id" text NOT NULL,
            "triggered_by" text NOT NULL,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY ("tenant_id", "run_id")
          );
        `);
        await sql.unsafe(
          `ALTER TABLE "public"."routine" ` +
            `ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0, ` +
            `ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamptz;`,
        );
        await sql.unsafe(
          `ALTER TABLE "public"."routine_run" ADD COLUMN IF NOT EXISTS "error" text;`,
        );
        await sql.unsafe(`
          CREATE TABLE IF NOT EXISTS "public"."routine_draft" (
            "id" text PRIMARY KEY,
            "tenant_id" text NOT NULL,
            "prompt" text NOT NULL,
            "status" text NOT NULL,
            "proposed_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
            "proposed_trigger" jsonb,
            "proposed_name" text,
            "definition_id" text,
            "delivery_channel_id" text NOT NULL,
            "scope" text NOT NULL,
            "autonomy" jsonb,
            "created_by" text NOT NULL,
            "approved_routine_id" text,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sql.unsafe(
          `INSERT INTO "public"."routine" ` +
            `(id, tenant_id, name, definition_id, scope, input, created_by) ` +
            `VALUES ('rtn_pre', 'tnt_pre', 'Pre-cutover', 'def_1', 'bench', '{}'::jsonb, 'user_1')`,
        );
        await sql.unsafe(
          `CREATE TABLE IF NOT EXISTS "public"."routine_migrations" (` +
            `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        await sql.unsafe(
          `INSERT INTO "public"."routine_migrations" (name) VALUES ` +
            `('0001_routine'), ('0002_failure_tracking'), ('0003_routine_draft')`,
        );
      } finally {
        await sql.end();
      }

      const report = await applyRoutineMigrations(scratchUrl);
      expect(report.applied).toEqual(["0004_move_tables_to_routines_schema"]);

      const sql2 = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        const inPublic = await sql2.unsafe(
          `SELECT table_name FROM information_schema.tables ` +
            `WHERE table_schema = 'public' AND table_name IN ` +
            `('routine', 'routine_run', 'routine_draft')`,
        );
        expect(inPublic).toHaveLength(0);

        const rows = await sql2.unsafe(
          `SELECT id, tenant_id FROM "routines"."routine"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.["id"]).toBe("rtn_pre");
      } finally {
        await sql2.end();
      }
    });
  },
);
