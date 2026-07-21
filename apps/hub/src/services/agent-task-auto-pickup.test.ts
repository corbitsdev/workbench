import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { schema } from "../db";
import type { HubDb } from "../db";
import { task } from "../db/schema";
import { createWorkUnitQueue } from "./work-unit-queue";
import {
  agentAutoPickupEnabled,
  agentTaskTurnIdempotencyKey,
  createDefaultAgentTaskTurnRunner,
  enqueueAgentTaskTurn,
  enqueueDueAgentTaskTurns,
  runAgentTaskTurnUnit,
  selectEligibleTasksForAutoPickup,
} from "./agent-task-auto-pickup";

const TENANT = "ten-agent";

let client: PGlite;
let db: HubDb;
let prevFlag: string | undefined;

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
  if (prevFlag === undefined) {
    delete process.env["AGENT_TASK_AUTO_PICKUP"];
  } else {
    process.env["AGENT_TASK_AUTO_PICKUP"] = prevFlag;
  }
});

beforeEach(async () => {
  await client.exec(`DELETE FROM work_unit;`);
  await client.exec(`DELETE FROM task;`);
  prevFlag = process.env["AGENT_TASK_AUTO_PICKUP"];
});

async function insertTask(args: {
  id?: string;
  status?: "open" | "in_progress" | "done" | "cancelled";
  assignee?: string | null;
}) {
  const id = args.id ?? crypto.randomUUID();
  await db.insert(task).values({
    id,
    tenantId: TENANT,
    ownerPrincipalId: "owner-1",
    createdByPrincipalId: "owner-1",
    assigneePrincipalId:
      args.assignee === undefined ? "agent-1" : args.assignee,
    title: "Test task",
    status: args.status ?? "open",
    source: "manual",
  });
  return id;
}

describe("agent task auto-pickup", () => {
  test("idempotency key never encodes a task-row lease", () => {
    expect(agentTaskTurnIdempotencyKey("t1", "auto")).toBe(
      "task:t1:turn:auto",
    );
  });

  test("policy selects only open tasks with an assignee", async () => {
    await insertTask({ id: crypto.randomUUID(), assignee: "a1" });
    await insertTask({
      id: crypto.randomUUID(),
      assignee: null,
    });
    await insertTask({
      id: crypto.randomUUID(),
      status: "done",
      assignee: "a1",
    });
    const eligible = await selectEligibleTasksForAutoPickup(db, {
      tenantId: TENANT,
    });
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.assigneePrincipalId).toBe("a1");
  });

  test("flag off: enqueueDue is a no-op", async () => {
    process.env["AGENT_TASK_AUTO_PICKUP"] = "0";
    expect(agentAutoPickupEnabled()).toBe(false);
    await insertTask({ assignee: "a1" });
    const queue = createWorkUnitQueue(db);
    const result = await enqueueDueAgentTaskTurns(db, queue, {
      tenantId: TENANT,
    });
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  test("two workers do not double-run the same turn", async () => {
    process.env["AGENT_TASK_AUTO_PICKUP"] = "1";
    const taskId = await insertTask({ assignee: "a1" });
    const queue = createWorkUnitQueue(db);
    await enqueueAgentTaskTurn(queue, {
      tenantId: TENANT,
      taskId,
      turnKey: "auto",
    });

    const [c1, c2] = await Promise.all([
      queue.claimDue({
        workerId: "w1",
        limit: 10,
        kinds: ["agent_task_turn"],
      }),
      queue.claimDue({
        workerId: "w2",
        limit: 10,
        kinds: ["agent_task_turn"],
      }),
    ]);
    const all = [...c1, ...c2];
    expect(all).toHaveLength(1);
  });

  test("human and agent coexist: task row is never the lease", async () => {
    process.env["AGENT_TASK_AUTO_PICKUP"] = "1";
    const taskId = await insertTask({ assignee: "a1" });
    const queue = createWorkUnitQueue(db);
    await enqueueDueAgentTaskTurns(db, queue, {
      tenantId: TENANT,
      turnKey: "auto",
    });

    await db
      .update(task)
      .set({ title: "Human edited title" })
      .where(eq(task.id, taskId));

    const [unit] = await queue.claimDue({
      workerId: "w1",
      limit: 1,
      kinds: ["agent_task_turn"],
    });
    expect(unit).toBeDefined();
    expect(unit!.payload["taskId"]).toBe(taskId);

    const runner = createDefaultAgentTaskTurnRunner(db);
    await runAgentTaskTurnUnit({
      tenantId: TENANT,
      payload: unit!.payload,
      runner,
      signal: new AbortController().signal,
    });
    await queue.complete(unit!.id, "w1");

    const rows = await db.select().from(task);
    expect(rows[0]?.title).toBe("Human edited title");
    expect(rows[0]?.status).toBe("in_progress");
  });

  test("enqueueDue is idempotent for the same turn key", async () => {
    process.env["AGENT_TASK_AUTO_PICKUP"] = "1";
    await insertTask({ assignee: "a1" });
    const queue = createWorkUnitQueue(db);
    const a = await enqueueDueAgentTaskTurns(db, queue, {
      tenantId: TENANT,
      turnKey: "auto",
    });
    const b = await enqueueDueAgentTaskTurns(db, queue, {
      tenantId: TENANT,
      turnKey: "auto",
    });
    expect(a.enqueued).toBe(1);
    expect(b.enqueued).toBe(0);
  });
});
