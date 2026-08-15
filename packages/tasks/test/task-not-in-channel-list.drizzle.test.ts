// Negative proof (CL-6049): a task-launched run never appears in the
// chat sidebar / channel listing. `launchTask`'s `persistExtra` only
// ever writes to `@corbits/tasks`' own `task` table — never to
// `@corbits/chat`'s `channel_settings` — so a tenant with both a real
// channel and a task has exactly one row in `listChannelSettings`,
// never two, and nothing in that row's settings ever names the task's
// run.
//
// DB-gated: skipped when no DATABASE_URL is reachable, mirroring this
// package's own `store.drizzle.test.ts`. Applies both packages'
// migrations to one scratch database, since the guarantee under test
// is specifically that the two product tables stay disjoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { applyChatMigrations } from "@corbits/chat/migrations";
import { createDrizzleChatStore } from "@corbits/chat";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyTasksMigrations } from "../src/migrations";
import { createDrizzleTaskStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_tasks_not_in_channel_list_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT_ID = "tnt_1";

describeIfDb("a task never appears in the channel listing", () => {
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
    await applyChatMigrations(scratchUrl);
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

  test("listChannelSettings sees the one real channel, never the task's run", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const db = drizzle(sql);
      const chatStore = createDrizzleChatStore(db);
      const taskStore = createDrizzleTaskStore(db);

      await chatStore.createChannelSettings({
        tenantId: TENANT_ID,
        channelId: "run_channel_host_1",
        settings: { "chat/kind": "channel" },
        updatedBy: "prn_1",
      });

      await taskStore.createTask({
        id: "task_1",
        tenantId: TENANT_ID,
        principalId: "prn_1",
        definitionId: "wfd_agent",
        agentName: "Agent",
        prompt: "Summarize the incident.",
        modelPreference: null,
        runId: "run_task_1",
      });

      const channels = await chatStore.listChannelSettings(TENANT_ID);
      expect(channels).toHaveLength(1);
      expect(channels[0]?.channelId).toBe("run_channel_host_1");
      expect(channels.some((row) => row.channelId === "run_task_1")).toBe(
        false,
      );

      const tasks = await taskStore.listTasks(TENANT_ID);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.runId).toBe("run_task_1");
    } finally {
      await sql.end();
    }
  });
});
