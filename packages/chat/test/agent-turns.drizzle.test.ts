// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `migrations.test.ts`. Runs against its own scratch database.
//
// `agent-turns.test.ts` proves the projection's contract against the
// in-memory store, which allocates occurrences on a single-threaded
// event loop and so can never actually race. This exercises the real
// `createDrizzleAgentTurnStore`, where two dispatches for the same
// (workbench, agent) really do race for the next occurrence — and
// therefore for a child run id. Two turns quietly sharing one run id is
// exactly the traceability hole this projection exists to close, so the
// bar here is that the race is loud, never silently duplicated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createDrizzleAgentTurnStore } from "../src/agent-turns";
import { applyChatMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_agent_turns_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";
const AGENT = "ins_echo1@acme.example";

describeIfDb("createDrizzleAgentTurnStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(
    run: (sql: ReturnType<typeof postgres>) => Promise<void>,
  ): Promise<void> {
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
    await applyChatMigrations(scratchUrl);
  });

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  });

  test("occurrences advance per (workbench, agent), and a turn round-trips", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleAgentTurnStore(drizzle(sql));

      const first = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: AGENT,
        requestMessageIds: ["msg_1"],
      });
      const second = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: AGENT,
        requestMessageIds: ["msg_2"],
      });
      const otherAgent = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: "ins_echo2@acme.example",
        requestMessageIds: ["msg_2"],
      });

      expect([first.childRunId, second.childRunId]).toEqual([
        "turn__0",
        "turn__1",
      ]);
      expect(otherAgent.childRunId).toBe("turn__0");
      expect(first.status).toBe("running");
      expect(first.requestMessageIds).toEqual(["msg_1"]);

      const finished = await store.finishTurn({
        tenantId: TENANT,
        turnId: first.id,
        status: "completed",
        sectionRunId: "wfr_section1",
        replyMessageId: "msg_reply",
      });
      expect(finished?.status).toBe("completed");
      expect(finished?.sectionRunId).toBe("wfr_section1");
      expect(finished?.endedAt).not.toBeNull();

      const read = await store.getTurn({ tenantId: TENANT, turnId: first.id });
      expect(read?.replyMessageId).toBe("msg_reply");
      expect(read?.childRunId).toBe("turn__0");

      const listed = await store.listTurns({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
      });
      expect(listed).toHaveLength(3);
    } finally {
      await sql.end();
    }
  });

  test("two dispatches racing for one agent never quietly share a child run id", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleAgentTurnStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: "run_race",
        agentAddress: AGENT,
        requestMessageIds: ["msg_race"],
      };

      const settled = await Promise.allSettled([
        store.startTurn(input),
        store.startTurn(input),
      ]);
      const opened = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      // Either both won distinct occurrences, or the unique index made
      // the loser fail loudly. What must never happen is two rows
      // claiming the same child run id.
      const childRunIds = opened.map((turn) => turn.childRunId);
      expect(new Set(childRunIds).size).toBe(childRunIds.length);

      const listed = await store.listTurns({
        tenantId: TENANT,
        workbenchId: "run_race",
      });
      expect(new Set(listed.map((turn) => turn.childRunId)).size).toBe(
        listed.length,
      );
    } finally {
      await sql.end();
    }
  });
});
