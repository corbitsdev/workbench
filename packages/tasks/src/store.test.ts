import { describe, expect, test } from "bun:test";

import { createMemoryTaskStore } from "./store";

const TENANT_A = "tnt_a";
const TENANT_B = "tnt_b";

describe("createMemoryTaskStore", () => {
  test("createTask persists a running task scoped to its tenant", async () => {
    const store = createMemoryTaskStore();
    const record = await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    expect(record.status).toBe("running");
    expect(record.resultMailId).toBeNull();
    expect(record.completedAt).toBeNull();

    const fetched = await store.getTask(TENANT_A, "task_1");
    expect(fetched).toEqual(record);
  });

  test("getTask never returns a task belonging to a different tenant", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    expect(await store.getTask(TENANT_B, "task_1")).toBeNull();
  });

  test("getTaskByRunId finds a task by its folded run id", async () => {
    const store = createMemoryTaskStore();
    const record = await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: "anthropic/claude-sonnet",
      runId: "run_abc",
    });

    expect(await store.getTaskByRunId("run_abc")).toEqual(record);
    expect(await store.getTaskByRunId("run_missing")).toBeNull();
  });

  test("listTasks returns a tenant's tasks newest first", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "first",
      modelPreference: null,
      runId: "run_1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await store.createTask({
      id: "task_2",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "second",
      modelPreference: null,
      runId: "run_2",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    await store.createTask({
      id: "task_3",
      tenantId: TENANT_B,
      principalId: "prn_2",
      definitionId: "wfd_agent",
      prompt: "other tenant",
      modelPreference: null,
      runId: "run_3",
    });

    const items = await store.listTasks(TENANT_A);
    expect(items.map((item) => item.id)).toEqual(["task_2", "task_1"]);
  });

  test("completeTask flips a running task and stamps completedAt", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    const completed = await store.completeTask({
      tenantId: TENANT_A,
      id: "task_1",
      status: "done",
    });

    expect(completed?.status).toBe("done");
    expect(completed?.completedAt).not.toBeNull();
  });

  test("completeTask is winner-takes-all: a second flip of the same task loses", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    const first = await store.completeTask({
      tenantId: TENANT_A,
      id: "task_1",
      status: "done",
    });
    const second = await store.completeTask({
      tenantId: TENANT_A,
      id: "task_1",
      status: "failed",
    });

    expect(first?.status).toBe("done");
    expect(second).toBeNull();
    expect((await store.getTask(TENANT_A, "task_1"))?.status).toBe("done");
  });

  test("completeTask returns null for an unknown task or wrong tenant", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    expect(
      await store.completeTask({
        tenantId: TENANT_B,
        id: "task_1",
        status: "failed",
      }),
    ).toBeNull();
    expect(
      await store.completeTask({
        tenantId: TENANT_A,
        id: "task_missing",
        status: "failed",
      }),
    ).toBeNull();
  });

  test("recordResultMail stamps the delivered mail id onto a completed task", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });
    await store.completeTask({
      tenantId: TENANT_A,
      id: "task_1",
      status: "done",
    });

    await store.recordResultMail({
      tenantId: TENANT_A,
      id: "task_1",
      resultMailId: "mail_1",
    });

    const record = await store.getTask(TENANT_A, "task_1");
    expect(record?.resultMailId).toBe("mail_1");
    expect(record?.status).toBe("done");
  });

  test("createTask defaults plannerRunId to null when omitted", async () => {
    const store = createMemoryTaskStore();
    const record = await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    expect(record.plannerRunId).toBeNull();
  });

  test("createTask accepts an explicit plannerRunId", async () => {
    const store = createMemoryTaskStore();
    const record = await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
      plannerRunId: "plan_1",
    });

    expect(record.plannerRunId).toBe("plan_1");
  });

  test("linkPlannerRun stamps the planner run id onto an existing task", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    await store.linkPlannerRun({
      tenantId: TENANT_A,
      id: "task_1",
      plannerRunId: "plan_1",
    });

    const record = await store.getTask(TENANT_A, "task_1");
    expect(record?.plannerRunId).toBe("plan_1");
  });

  test("linkPlannerRun is a no-op for a task in a different tenant", async () => {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_agent",
      prompt: "Summarize the incident.",
      modelPreference: null,
      runId: "run_1",
    });

    await store.linkPlannerRun({
      tenantId: TENANT_B,
      id: "task_1",
      plannerRunId: "plan_1",
    });

    const record = await store.getTask(TENANT_A, "task_1");
    expect(record?.plannerRunId).toBeNull();
  });
});

describe("claimLegDispatch", () => {
  async function seedPendingLeg() {
    const store = createMemoryTaskStore();
    await store.createTask({
      id: "task_1",
      tenantId: TENANT_A,
      principalId: "prn_1",
      definitionId: "wfd_researcher",
      prompt: "Research the outage.",
      modelPreference: null,
      runId: "run_leg0",
      followOn: [
        {
          definitionId: "wfd_editor",
          prompt: "Edit the findings.",
          modelPreference: null,
        },
      ],
    });
    const legs = await store.listLegs(TENANT_A, "task_1");
    const pending = legs[1];
    if (pending === undefined) throw new Error("no follow-on leg was seeded");
    return { store, pending };
  }

  test("two callers racing for the same pending leg: exactly one wins", async () => {
    const { store, pending } = await seedPendingLeg();
    const now = new Date("2026-08-14T10:00:00.000Z");
    const leaseExpiresAt = new Date(now.getTime() + 30_000);

    // Both callers see the same pending leg and claim it at the same
    // instant, each proposing its own live lease. Two agents launched
    // for one hand-off is the failure this guards.
    const claims = await Promise.all([
      store.claimLegDispatch({
        tenantId: TENANT_A,
        legId: pending.id,
        parentRunId: "run_leg0",
        leaseExpiresAt,
        now,
      }),
      store.claimLegDispatch({
        tenantId: TENANT_A,
        legId: pending.id,
        parentRunId: "run_leg0",
        leaseExpiresAt,
        now,
      }),
    ]);

    const won = claims.filter((claim) => claim !== null);
    expect(won).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(won[0]?.status).toBe("dispatching");
    expect(won[0]?.runId).toBeNull();
  });

  test("a live lease refuses every later claim until it passes", async () => {
    const { store, pending } = await seedPendingLeg();
    const claimedAt = new Date("2026-08-14T10:00:00.000Z");
    const leaseExpiresAt = new Date(claimedAt.getTime() + 30_000);

    const claim = (now: Date) =>
      store.claimLegDispatch({
        tenantId: TENANT_A,
        legId: pending.id,
        parentRunId: "run_leg0",
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        now,
      });

    expect(await claim(claimedAt)).not.toBeNull();
    // Inside the lease the leg belongs to whoever holds it, however
    // many callers ask; only a lease that has genuinely passed hands
    // the leg to the next one.
    expect(await claim(new Date(leaseExpiresAt.getTime() - 1))).toBeNull();
    expect(await claim(new Date(leaseExpiresAt.getTime() + 1))).not.toBeNull();
  });
});
