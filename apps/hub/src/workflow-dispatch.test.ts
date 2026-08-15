// Proves the two loops this app owns actually fire — the wiring, not
// the platform service's own behaviour: an exclusive worker's deploy
// ack requeues that anchor's unsettled payloads, a durable-inbox ack
// acknowledges the exact delivery, and the reconcile tick keeps
// draining after `enqueue` has stopped waking it.
import { describe, expect, test } from "bun:test";
import { createSidecarEmitter } from "@intx/hub-sessions";

import { startWorkflowDispatch } from "./workflow-dispatch";

/**
 * A drizzle stand-in for the one query this wiring issues — the
 * anchor's routing address. The dispatch service does the rest against
 * stores it builds itself, which never run here because no payload is
 * ever enqueued.
 */
function fakeDb(): never {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ address: "run_1@test" }] }),
      }),
    }),
  } as never;
}

function fakeRouter() {
  return {
    sendSignalDeliverToAllocation: async () => undefined,
    sendWorkflowRunDispatchToAllocation: async () => undefined,
  } as never;
}

describe("startWorkflowDispatch", () => {
  test("an exclusive worker's deploy ack requeues that anchor's unsettled payloads", async () => {
    const events = createSidecarEmitter();
    const requeued: string[] = [];
    const wiring = startWorkflowDispatch({
      db: fakeDb(),
      router: fakeRouter(),
      events,
    });
    Object.assign(wiring.service, {
      requeueForReadyAllocation: async (anchorRunId: string) => {
        requeued.push(anchorRunId);
        return 0;
      },
    });

    events.emit("agent.deploy.ack", {
      agentAddress: "run_1@test",
      publicKey: "ff",
      allocated: {
        allocationId: "alloc_1",
        anchorRunId: "run_1",
        generation: 3,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requeued).toEqual(["run_1"]);
    wiring.stop();
  });

  test("a shared-capacity deploy ack requeues nothing", async () => {
    const events = createSidecarEmitter();
    const requeued: string[] = [];
    const wiring = startWorkflowDispatch({
      db: fakeDb(),
      router: fakeRouter(),
      events,
    });
    Object.assign(wiring.service, {
      requeueForReadyAllocation: async (anchorRunId: string) => {
        requeued.push(anchorRunId);
        return 0;
      },
    });

    events.emit("agent.deploy.ack", {
      agentAddress: "run_2@test",
      publicKey: "ff",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requeued).toEqual([]);
    wiring.stop();
  });

  test("a durable-inbox ack acknowledges the exact delivery it names", async () => {
    const events = createSidecarEmitter();
    const acknowledged: unknown[] = [];
    const wiring = startWorkflowDispatch({
      db: fakeDb(),
      router: fakeRouter(),
      events,
    });
    Object.assign(wiring.service, {
      acknowledge: async (args: unknown) => {
        acknowledged.push(args);
      },
    });

    events.emit("mail.inbound.acknowledged", {
      agentAddress: "run_1@test",
      messageId: "<msg_1@test>",
      allocated: {
        allocationId: "alloc_1",
        anchorRunId: "run_1",
        generation: 3,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(acknowledged).toEqual([
      {
        allocationId: "alloc_1",
        anchorRunId: "run_1",
        generation: 3,
        messageId: "<msg_1@test>",
      },
    ]);
    wiring.stop();
  });

  test("the reconcile tick keeps draining, and stopping ends it", async () => {
    const events = createSidecarEmitter();
    const wiring = startWorkflowDispatch({
      db: fakeDb(),
      router: fakeRouter(),
      events,
      reconcileIntervalMs: 1,
    });
    let wakes = 0;
    Object.assign(wiring.service, {
      wake: () => {
        wakes += 1;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(wakes).toBeGreaterThan(0);

    wiring.stop();
    const afterStop = wakes;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(wakes).toBe(afterStop);
  });
});
