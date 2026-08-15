// DB-gated: runs against its own scratch database, never the
// developer's or the walking-skeleton suite's, mirroring
// packages/notify/test/migrations.test.ts.
//
// The load-bearing case here is the cutover from one-run-per-task to
// many: a task written before `0004_task_leg` existed carries its run
// on the `task` row alone, and must read back through the leg-aware
// store afterwards with exactly the run it always had.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyTasksMigrations, tasksMigrations } from "../src/migrations";
import { createDrizzleTaskStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_tasks_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const LEG_MIGRATION = "0004_task_leg";

describeIfDb("applyTasksMigrations", () => {
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

  test("a task written before chains existed still reads back with its run", async () => {
    // Apply everything up to (but not including) the leg migration, so
    // the seeded rows are genuinely old-shape rather than a
    // post-migration imitation of one.
    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "tasks"`);
      await client.unsafe(
        `CREATE TABLE "tasks"."tasks_migrations" ` +
          `(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migration of tasksMigrations) {
        if (migration.name === LEG_MIGRATION) break;
        await client.unsafe(migration.sql);
        await client.unsafe(
          `INSERT INTO "tasks"."tasks_migrations" (name) VALUES ($1)`,
          [migration.name],
        );
      }

      await client.unsafe(
        `INSERT INTO "tasks"."task" ` +
          `("id", "tenant_id", "principal_id", "definition_id", "agent_name", "prompt", ` +
          `"model_preference", "status", "run_id", "result_mail_id", "completed_at") ` +
          `VALUES ` +
          `('task_old_done', 'tnt_1', 'prn_ada', 'wfd_agent', 'Agent', 'Summarize it.', ` +
          `NULL, 'done', 'run_old_done', 'mail_1', now()), ` +
          `('task_old_running', 'tnt_1', 'prn_ada', 'wfd_agent', 'Agent', 'Keep going.', ` +
          `'claude-sonnet-5', 'running', 'run_old_running', NULL, NULL)`,
      );

      const report = await applyTasksMigrations(scratchUrl);
      expect(report.applied).toEqual([
        LEG_MIGRATION,
        "0005_task_leg_started_at",
      ]);

      const store = createDrizzleTaskStore(drizzle(client));

      const done = await store.getTask("tnt_1", "task_old_done");
      expect(done?.status).toBe("done");
      expect(done?.runId).toBe("run_old_done");
      expect(done?.runIds).toEqual(["run_old_done"]);
      expect(done?.stepCount).toBe(1);
      expect(done?.resultMailId).toBe("mail_1");

      const running = await store.getTask("tnt_1", "task_old_running");
      expect(running?.runIds).toEqual(["run_old_running"]);
      expect(running?.modelPreference).toBe("claude-sonnet-5");

      // The run-id lookup the orchestrator resolves terminal events
      // through must find a backfilled leg just as it finds a new one.
      expect((await store.getTaskByRunId("run_old_running"))?.id).toBe(
        "task_old_running",
      );

      // A backfilled leg mirrors its task's terminal state, so a
      // migrated done task is never mistaken for one still running.
      const legs = await store.listLegs("tnt_1", "task_old_done");
      expect(legs).toHaveLength(1);
      expect(legs[0]?.position).toBe(0);
      expect(legs[0]?.status).toBe("done");
      expect(legs[0]?.parentRunId).toBeNull();
    } finally {
      await client.end();
    }
  }, 30000);

  test("re-running the leg migration is a no-op, never a second backfill", async () => {
    const second = await applyTasksMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain(LEG_MIGRATION);

    const client = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const rows = await client.unsafe(
        `SELECT count(*)::int AS n FROM "tasks"."task_leg"`,
      );
      expect(rows[0]?.["n"]).toBe(2);

      const inPublic = await client.unsafe(
        `SELECT 1 FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name = 'task_leg'`,
      );
      expect(inPublic).toHaveLength(0);
    } finally {
      await client.end();
    }
  }, 20000);
});
