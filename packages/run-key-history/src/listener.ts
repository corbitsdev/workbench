// Wires `RunKeyHistoryStore` onto the hub's own `agent.deploy.ack`
// stream, independently of `@intx/hub-sessions`' vendored listener on
// the same event. Both listeners read the SAME ack payload but never
// coordinate: this one never reads `workflow_run` at all, comparing
// only against its own last-recorded entry, so there is no race with
// vendor's independent `UPDATE workflow_run SET public_key = ...`.
import { getLogger } from "@intx/log";
import type { RunKeyHistoryStore } from "./store";

/** The narrow slice of `agent.deploy.ack`'s payload this listener
 * needs — matches `@intx/hub-sessions`' own `SidecarEventEmitter`
 * shape for that event, without depending on the whole vendor type. */
export type AgentDeployAckEvent = {
  agentAddress: string;
  publicKey: string;
  allocated?: unknown;
};

export type RunKeyHistoryEventBus = {
  on(
    type: "agent.deploy.ack",
    listener: (event: AgentDeployAckEvent) => void,
  ): () => void;
};

export type CreateRunKeyHistoryListenerDeps = {
  events: RunKeyHistoryEventBus;
  store: RunKeyHistoryStore;
};

export type RunKeyHistoryListener = {
  dispose(): void;
};

/**
 * Subscribes to `agent.deploy.ack` and records every observed key
 * against `RunKeyHistoryStore`, including exclusive-allocation acks
 * (`allocated !== undefined`). Vendor's orchestrator listener skips
 * those acks when writing `workflow_run.public_key`; the service path
 * (`updateAnchorPublicKeyUnderAllocationLock`) still stamps the key,
 * so history must record it too.
 */
export function createRunKeyHistoryListener(
  deps: CreateRunKeyHistoryListenerDeps,
): RunKeyHistoryListener {
  const log = getLogger(["run-key-history", "listener"]);

  const unsubscribe = deps.events.on("agent.deploy.ack", (event) => {
    deps.store
      .recordObservedKey(event.agentAddress, event.publicKey)
      .catch((cause: unknown) => {
        log.error`failed to record key history for ${event.agentAddress}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      });
  });

  return {
    dispose: unsubscribe,
  };
}
