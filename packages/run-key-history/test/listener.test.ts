import { describe, expect, test } from "bun:test";
import {
  createRunKeyHistoryListener,
  type AgentDeployAckEvent,
  type RunKeyHistoryEventBus,
} from "../src/listener";
import type { RunKeyHistoryStore } from "../src/store";

function createFakeEventBus(): RunKeyHistoryEventBus & {
  emit(event: AgentDeployAckEvent): void;
} {
  const listeners = new Set<(event: AgentDeployAckEvent) => void>();
  return {
    on(_type, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function createFakeStore(): RunKeyHistoryStore & {
  calls: { runAddress: string; publicKey: string }[];
} {
  const calls: { runAddress: string; publicKey: string }[] = [];
  return {
    calls,
    async recordObservedKey(runAddress, publicKey) {
      calls.push({ runAddress, publicKey });
    },
    async getCurrent() {
      return null;
    },
  };
}

describe("createRunKeyHistoryListener", () => {
  test("records every ordinary agent.deploy.ack", () => {
    const events = createFakeEventBus();
    const store = createFakeStore();
    createRunKeyHistoryListener({ events, store });

    events.emit({ agentAddress: "run_1@ten1.test", publicKey: "key-a" });

    expect(store.calls).toEqual([
      { runAddress: "run_1@ten1.test", publicKey: "key-a" },
    ]);
  });

  test("records an exclusive-allocation ack", () => {
    const events = createFakeEventBus();
    const store = createFakeStore();
    createRunKeyHistoryListener({ events, store });

    events.emit({
      agentAddress: "run_1@ten1.test",
      publicKey: "key-a",
      allocated: {
        allocationId: "alloc_1",
        anchorRunId: "run_0",
        generation: 1,
      },
    });

    expect(store.calls).toEqual([
      { runAddress: "run_1@ten1.test", publicKey: "key-a" },
    ]);
  });

  test("dispose stops observing further acks", () => {
    const events = createFakeEventBus();
    const store = createFakeStore();
    const listener = createRunKeyHistoryListener({ events, store });

    listener.dispose();
    events.emit({ agentAddress: "run_1@ten1.test", publicKey: "key-a" });

    expect(store.calls).toEqual([]);
  });

  // Exclusive-allocation deploys stamp `allocated` on the ack and rotate
  // `workflow_run.public_key` on the service path
  // (`updateAnchorPublicKeyUnderAllocationLock`), not the orchestrator
  // listener. History must still record that key.
  test("an exclusive-allocation ack still rotates workflow_run.public_key, so it must be recorded", () => {
    const events = createFakeEventBus();
    const store = createFakeStore();
    createRunKeyHistoryListener({ events, store });

    const workflowRun: { publicKey: string | null } = { publicKey: null };
    events.on("agent.deploy.ack", (event) => {
      workflowRun.publicKey = event.publicKey;
    });

    events.emit({
      agentAddress: "run_1@ten1.test",
      publicKey: "key-a",
      allocated: {
        allocationId: "alloc_1",
        anchorRunId: "run_1",
        generation: 1,
      },
    });

    expect(workflowRun.publicKey).toBe("key-a");
    expect(store.calls).toEqual([
      { runAddress: "run_1@ten1.test", publicKey: "key-a" },
    ]);
  });
});
