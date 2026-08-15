// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring
// packages/routines/test/store.drizzle.test.ts. Runs against its own
// scratch database, never the developer's or the walking-skeleton
// suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyTasksMigrations } from "../src/migrations";
import { createDrizzleTaskStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_tasks_store_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT_A = "tnt_a";
const TENANT_B = "tnt_b";

describeIfDb("createDrizzleTaskStore", () => {
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
    await applyTasksMigrations(scratchUrl);
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

  test("create, read, list and complete a task round-trip through Postgres", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const store = createDrizzleTaskStore(drizzle(sql));

      const created = await store.createTask({
        id: "task_1",
        tenantId: TENANT_A,
        principalId: "prn_1",
        definitionId: "wfd_agent",
        prompt: "Summarize the incident.",
        modelPreference: null,
        runId: "run_1",
      });
      expect(created.status).toBe("running");

      const fetched = await store.getTask(TENANT_A, "task_1");
      expect(fetched?.prompt).toBe("Summarize the incident.");
      expect(await store.getTask(TENANT_B, "task_1")).toBeNull();

      const byRun = await store.getTaskByRunId("run_1");
      expect(byRun?.id).toBe("task_1");

      const completed = await store.completeTask({
        tenantId: TENANT_A,
        id: "task_1",
        status: "done",
        resultMailId: "mail_1",
      });
      expect(completed?.status).toBe("done");
      expect(completed?.resultMailId).toBe("mail_1");
      expect(completed?.completedAt).not.toBeNull();

      const listed = await store.listTasks(TENANT_A);
      expect(listed.map((item) => item.id)).toEqual(["task_1"]);
    } finally {
      await sql.end();
    }
  });
});
