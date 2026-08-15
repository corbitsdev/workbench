// The hand-off's three hard guarantees, each proved against the
// in-memory store rather than a mock of it: a settled leg hands on
// exactly once no matter how many times settlement is replayed, a
// claim that dies before it launches becomes claimable again while one
// that DID launch never does, and a hand-off that cannot start the
// next agent fails the leg rather than reporting a chain that quietly
// stopped halfway.
import { describe, expect, test } from "bun:test";

import { advanceChain, HANDOFF_FAILED_MESSAGE } from "./chain";
import { createMemoryTaskStore, type TaskStore } from "./store";

const TENANT = "tnt_1";

async function seedChain(
  store: TaskStore,
  followOnCount: number,
): Promise<{ taskId: string }> {
  await store.createTask({
    id: "task_1",
    tenantId: TENANT,
    principalId: "prn_alice",
    definitionId: "wfd_researcher",
    prompt: "Research the outage.",
    modelPreference: null,
    runId: "run_leg0",
    followOn: Array.from({ length: followOnCount }, (_unused, index) => ({
      definitionId: `wfd_follow_${String(index)}`,
      prompt: `Continue step ${String(index + 1)}.`,
      modelPreference: null,
    })),
  });
  return { taskId: "task_1" };
}

async function settleFirstLeg(store: TaskStore) {
  const legs = await store.listLegs(TENANT, "task_1");
  const first = legs[0];
  if (first === undefined) throw new Error("no first leg was seeded");
  const settled = await store.settleLeg({
    tenantId: TENANT,
    legId: first.id,
    status: "done",
  });
  if (settled === null) throw new Error("the first leg would not settle");
  return settled;
}

describe("advanceChain", () => {
  test("a settled leg hands its work to the next agent exactly once", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const settledLeg = await settleFirstLeg(store);
    const launches: string[] = [];

    const deps = {
      store,
      launchLeg: async (input: {
        tenantId: string;
        legId: string;
        definitionId: string;
      }) => {
        launches.push(input.definitionId);
        const runId = `run_leg1`;
        await store.recordLegRun({
          tenantId: input.tenantId,
          legId: input.legId,
          runId,
        });
        return runId;
      },
    };

    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    const first = await advanceChain(deps, { task, settledLeg });
    expect(first.kind).toBe("dispatched");
    expect(launches).toEqual(["wfd_follow_0"]);

    // Settlement redelivered: the same terminal event arriving twice
    // must find the next leg already claimed, never launch a second
    // agent for the same hand-off.
    const second = await advanceChain(deps, { task, settledLeg });
    expect(second.kind).toBe("already-claimed");
    expect(launches).toEqual(["wfd_follow_0"]);
  });

  test("the final leg's settlement completes the chain rather than handing on", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 0);
    const settledLeg = await settleFirstLeg(store);
    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    const advance = await advanceChain(
      {
        store,
        launchLeg: async () => {
          throw new Error("a single-agent task must never hand on");
        },
      },
      { task, settledLeg },
    );

    expect(advance.kind).toBe("chain-complete");
  });

  test("a lease that expires before the agent started redelivers the hand-off", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const settledLeg = await settleFirstLeg(store);
    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    const claimedAt = new Date("2026-08-14T10:00:00.000Z");
    const afterLease = new Date("2026-08-14T10:01:00.000Z");
    const launches: string[] = [];

    // A host that took the claim and then died leaves the leg exactly
    // like this: claimed, leased, no run — the crash window a lease
    // exists to bound. No `advanceChain` here, because a caught
    // failure would have settled the leg; a crash settles nothing.
    const legs = await store.listLegs(TENANT, "task_1");
    const next = legs[1];
    if (next === undefined) throw new Error("no follow-on leg");
    const abandoned = await store.claimLegDispatch({
      tenantId: TENANT,
      legId: next.id,
      parentRunId: "run_leg0",
      leaseExpiresAt: claimedAt,
      now: new Date(claimedAt.getTime() - 1),
    });
    expect(abandoned?.status).toBe("dispatching");

    const redelivered = await advanceChain(
      {
        store,
        now: () => afterLease,
        launchLeg: async (input) => {
          launches.push(input.legId);
          await store.recordLegRun({
            tenantId: input.tenantId,
            legId: input.legId,
            runId: "run_leg1",
          });
          return "run_leg1";
        },
      },
      { task, settledLeg },
    );
    expect(redelivered.kind).toBe("dispatched");
    expect(launches).toEqual([next.id]);
  });

  test("a lease that expires after the agent started never runs it twice", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const settledLeg = await settleFirstLeg(store);
    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    const claimedAt = new Date("2026-08-14T10:00:00.000Z");
    const launches: string[] = [];
    const launchLeg = async (input: { tenantId: string; legId: string }) => {
      launches.push(input.legId);
      await store.recordLegRun({
        tenantId: input.tenantId,
        legId: input.legId,
        runId: "run_leg1",
      });
      return "run_leg1";
    };

    await advanceChain(
      { store, now: () => claimedAt, launchLeg },
      { task, settledLeg },
    );

    // Long past any lease: the leg carries a run id now, so the claim
    // predicate must refuse it however stale the lease looks.
    const later = await advanceChain(
      {
        store,
        now: () => new Date("2026-09-14T10:00:00.000Z"),
        launchLeg,
      },
      { task, settledLeg },
    );

    expect(later.kind).toBe("already-claimed");
    expect(launches).toHaveLength(1);
  });

  test("a hand-off that cannot start the next agent fails the leg honestly", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const settledLeg = await settleFirstLeg(store);
    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    const advance = await advanceChain(
      {
        store,
        launchLeg: async () => {
          throw new Error("that agent is no longer available");
        },
      },
      { task, settledLeg },
    );

    expect(advance).toEqual({
      kind: "dispatch-failed",
      errorMessage: HANDOFF_FAILED_MESSAGE,
    });

    const legs = await store.listLegs(TENANT, "task_1");
    expect(legs[1]?.status).toBe("failed");
    expect(legs[1]?.errorMessage).toContain("no longer available");
    expect(legs[1]?.runId).toBeNull();
  });

  test("a hand-off whose prompt never reaches its agent fails the leg, never strands it", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const settledLeg = await settleFirstLeg(store);
    const task = await store.getTask(TENANT, "task_1");
    if (task === null) throw new Error("no task");

    // Exactly what `launchTaskLeg` does when the run commits but its
    // opening prompt cannot be delivered: the run id is recorded (so a
    // redelivered claim can never launch a second agent), the leg is
    // never confirmed as started, and the launch throws.
    const advance = await advanceChain(
      {
        store,
        launchLeg: async (input) => {
          await store.recordLegRun({
            tenantId: input.tenantId,
            legId: input.legId,
            runId: "run_leg1",
          });
          throw new Error("its instructions couldn't be delivered");
        },
      },
      { task, settledLeg },
    );

    expect(advance.kind).toBe("dispatch-failed");

    const legs = await store.listLegs(TENANT, "task_1");
    expect(legs[1]?.status).toBe("failed");
    expect(legs[1]?.errorMessage).toContain("couldn't be delivered");
    expect(legs[1]?.startedAt).toBeNull();

    // The orphan run is kept on the row for tracing, but a run that was
    // never prompted is not a run the task actually passed through —
    // counting it would tell the person their work stopped one agent
    // later than it did.
    expect(legs[1]?.runId).toBe("run_leg1");
    expect((await store.getTask(TENANT, "task_1"))?.runIds).toEqual([
      "run_leg0",
    ]);
  });
});

describe("settleLeg", () => {
  test("settling the same leg twice is a no-op the second time", async () => {
    const store = createMemoryTaskStore();
    await seedChain(store, 1);
    const legs = await store.listLegs(TENANT, "task_1");
    const first = legs[0];
    if (first === undefined) throw new Error("no first leg");

    const won = await store.settleLeg({
      tenantId: TENANT,
      legId: first.id,
      status: "done",
    });
    const lost = await store.settleLeg({
      tenantId: TENANT,
      legId: first.id,
      status: "failed",
    });

    expect(won?.status).toBe("done");
    expect(lost).toBeNull();
    expect((await store.listLegs(TENANT, "task_1"))[0]?.status).toBe("done");
  });
});
