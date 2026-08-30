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

  test("skips an exclusive-allocation ack, mirroring vendor's own guard", () => {
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

    expect(store.calls).toEqual([]);
  });

  test("dispose stops observing further acks", () => {
    const events = createFakeEventBus();
    const store = createFakeStore();
    const listener = createRunKeyHistoryListener({ events, store });

    listener.dispose();
    events.emit({ agentAddress: "run_1@ten1.test", publicKey: "key-a" });

    expect(store.calls).toEqual([]);
  });

  // CL-7274: the "skips an exclusive-allocation ack" test above documents an
  // assumption -- that vendor "skips its own workflow_run update for the same
  // ack" the way this listener does -- that does not hold.
  //
  // Read from vendored source, not inferred:
  //   - vendor/intx/hub-sessions/src/ws/sidecar-handler.ts:3070-3094
  //     (`handleDeployAck`) stamps `allocated: {...}` onto every
  //     `agent.deploy.ack` emitted for a connection whose `identity.kind` is
  //     "allocated" -- unconditionally, for every exclusive-allocation deploy.
  //   - vendor/intx/hub-sessions/src/session-service.ts:1812-1872
  //     (`updateAnchorPublicKeyUnderAllocationLock`) reads that SAME ack's
  //     `publicKey` (via `emitSourceRefDeployFrame` -> `sendAgentDeployToAllocation`)
  //     and unconditionally writes it onto `workflow_run.public_key` -- no
  //     `allocated` guard of its own. It is called from
  //     `deployPreparedCodeSourcedWorkflow` (session-service.ts:1884), which
  //     `workflow-allocation-service.ts:387`'s `deployReadyAllocation` drives
  //     from apps/hub/src/index.ts's live 1s allocation-reconciliation loop
  //     (`onReady` callback) for every exclusive-allocation deploy AND every
  //     allocation replacement after a sidecar failure (the prior key is first
  //     nulled by vendor/intx/db/src/sidecar-allocation-store.ts:620-631's
  //     `beginReplacement`, then re-stamped here).
  //
  // So vendor's OWN write to `workflow_run.public_key` for this ack is NOT
  // event-driven and carries no `allocated` filter -- only THIS listener (and
  // `hub-session-orchestrator.ts`'s own event-driven mirror of it) skip the
  // ack. The key rotates; run-key-history never observes it. Every
  // exclusive-allocation-deployed workflow run -- a live, wired-up product
  // path (apps/hub/src/index.ts's `sidecarPlacement`/dedicated-capacity
  // feature) -- has a permanent, 100%-reproducible history gap: not one
  // key, ever, including its very first one.
  //
  // This test is `.failing`: it documents the gap against the CURRENT listener
  // contract without turning it red for everyone. Flip it to a plain `test`
  // once the fix (or the upstream ruling from CL-7274) lands.
  test.failing(
    "CL-7274: an exclusive-allocation ack still rotates workflow_run.public_key, so it must be recorded",
    () => {
      const events = createFakeEventBus();
      const store = createFakeStore();
      createRunKeyHistoryListener({ events, store });

      // Models vendor's OWN independent, unconditional write to
      // `workflow_run.public_key` for this exact ack (session-service.ts:1853).
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

      // The rotation is real and already landed on workflow_run...
      expect(workflowRun.publicKey).toBe("key-a");
      // ...but run-key-history never recorded it. This is the gap.
      expect(store.calls).toEqual([
        { runAddress: "run_1@ten1.test", publicKey: "key-a" },
      ]);
    },
  );
});
