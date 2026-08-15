// The crash window made visible: a leg that was claimed, whose agent
// never started, and whose lease has long passed is going nowhere on
// its own — nothing redelivers it, because the settlement that would
// have redelivered it has already been consumed. These tests pin that
// such a leg is given up on exactly once, that the person hears about
// it in their own words, and that a leg still within its lease is left
// alone.
import { describe, expect, test } from "bun:test";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type NotifyDeliveryDeps,
  type NotifyInboxItem,
} from "@corbits/notify";

import { createMemoryTaskStore, type TaskStore } from "./store";
import { STUCK_LEG_MESSAGE, tickStuckLegSweep } from "./stuck-legs";

const TENANT = "tnt_1";

function fakeDb() {
  return {
    query: {
      workflowDefinition: { findFirst: async () => ({ name: "Researcher" }) },
    },
  } as never;
}

function fakeNotify(): {
  readonly deps: NotifyDeliveryDeps;
  readonly delivered: readonly NotifyInboxItem[][];
} {
  const delivered: NotifyInboxItem[][] = [];
  return {
    deps: {
      mail: async (items, opts) => {
        delivered.push([...items]);
        return items.map((item, index) => {
          const id = `mail_${String(delivered.length)}_${String(index)}`;
          opts?.enqueue?.({ id, item });
          return { messageKey: `key_${String(index)}`, id };
        });
      },
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.test`,
        from: (kind) => `${kind}@notify.test`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
    delivered,
  };
}

const CLAIMED_AT = new Date("2026-08-14T10:00:00.000Z");
const LEASE_EXPIRES_AT = new Date("2026-08-14T10:00:30.000Z");

async function seedClaimedLeg(store: TaskStore) {
  await store.createTask({
    id: "task_1",
    tenantId: TENANT,
    principalId: "prn_alice",
    definitionId: "wfd_researcher",
    prompt: "Research the outage.",
    modelPreference: null,
    runId: "run_leg0",
    createdAt: CLAIMED_AT,
    followOn: [
      {
        definitionId: "wfd_editor",
        prompt: "Edit the findings.",
        modelPreference: null,
      },
    ],
  });
  const legs = await store.listLegs(TENANT, "task_1");
  const next = legs[1];
  if (next === undefined) throw new Error("no follow-on leg was seeded");
  const claimed = await store.claimLegDispatch({
    tenantId: TENANT,
    legId: next.id,
    parentRunId: "run_leg0",
    leaseExpiresAt: LEASE_EXPIRES_AT,
    now: CLAIMED_AT,
  });
  if (claimed === null) throw new Error("the follow-on leg would not claim");
  return claimed;
}

describe("tickStuckLegSweep", () => {
  test("a hand-off that never started is failed, and the person is told plainly", async () => {
    const store = createMemoryTaskStore();
    await seedClaimedLeg(store);
    const notify = fakeNotify();

    await tickStuckLegSweep({
      db: fakeDb(),
      store,
      notify: notify.deps,
      now: () => new Date("2026-08-14T10:30:00.000Z"),
    });

    const legs = await store.listLegs(TENANT, "task_1");
    expect(legs[1]?.status).toBe("failed");
    expect(legs[1]?.errorMessage).toBe(STUCK_LEG_MESSAGE);
    expect((await store.getTask(TENANT, "task_1"))?.status).toBe("failed");

    expect(notify.delivered).toHaveLength(1);
    const body = notify.delivered[0]?.[0]?.body ?? "";
    expect(body).toContain(STUCK_LEG_MESSAGE);
    // The Inbox speaks the product's own words, never the machinery's.
    expect(body).not.toMatch(/dispatch|lease|reconcile|leg\b/i);
  });

  test("a hand-off still inside its lease is left alone", async () => {
    const store = createMemoryTaskStore();
    await seedClaimedLeg(store);
    const notify = fakeNotify();

    await tickStuckLegSweep({
      db: fakeDb(),
      store,
      notify: notify.deps,
      now: () => new Date("2026-08-14T10:00:20.000Z"),
    });

    const legs = await store.listLegs(TENANT, "task_1");
    expect(legs[1]?.status).toBe("dispatching");
    expect((await store.getTask(TENANT, "task_1"))?.status).toBe("running");
    expect(notify.delivered).toHaveLength(0);
  });

  test("a lease that only just passed is given its grace before being given up on", async () => {
    const store = createMemoryTaskStore();
    await seedClaimedLeg(store);
    const notify = fakeNotify();

    await tickStuckLegSweep({
      db: fakeDb(),
      store,
      notify: notify.deps,
      now: () => new Date("2026-08-14T10:00:35.000Z"),
    });

    expect((await store.listLegs(TENANT, "task_1"))[1]?.status).toBe(
      "dispatching",
    );
    expect(notify.delivered).toHaveLength(0);
  });

  test("sweeping twice tells the person once", async () => {
    const store = createMemoryTaskStore();
    await seedClaimedLeg(store);
    const notify = fakeNotify();
    const deps = {
      db: fakeDb(),
      store,
      notify: notify.deps,
      now: () => new Date("2026-08-14T10:30:00.000Z"),
    };

    await tickStuckLegSweep(deps);
    await tickStuckLegSweep(deps);

    expect(notify.delivered).toHaveLength(1);
  });
});
