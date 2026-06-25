import { useMemo, useSyncExternalStore } from "react";
import {
  createAgentPhaseTracker,
  type AgentPhase,
} from "@workbench/agents/browser";
import { createHubTransport } from "./instance-transport";

export interface AgentPhaseTarget {
  instanceId: string;
  tenantId: string;
}

interface PhaseStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => AgentPhase | null;
}

// A store adapter around a phase tracker, shaped for useSyncExternalStore. The
// tracker (and its underlying shared event subscription) is created lazily on
// the first subscriber and torn down when the last one leaves, so a row that
// unmounts — an agent leaving the list — releases exactly its own subscription
// without disturbing any other row.
function createPhaseStore(target: AgentPhaseTarget | null): PhaseStore {
  if (target === null) {
    return { subscribe: () => () => undefined, getSnapshot: () => null };
  }

  let tracker: ReturnType<typeof createAgentPhaseTracker> | null = null;
  const listeners = new Set<() => void>();

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (tracker === null) {
        tracker = createAgentPhaseTracker(createHubTransport(), target, () => {
          for (const listener of listeners) listener();
        });
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && tracker !== null) {
          tracker.stop();
          tracker = null;
        }
      };
    },
    getSnapshot() {
      return tracker?.phase ?? "idle";
    },
  };
}

/**
 * Subscribes to one agent's live activity phase (idle / thinking / typing) for
 * the sidebar, or returns null when there is no agent to track (a stopped or
 * deploying agent). Built on useSyncExternalStore rather than an effect: the
 * subscription's lifecycle is owned by React's mount/unmount of the row that
 * calls this, so each agent is independent.
 */
export function useAgentPhase(
  target: AgentPhaseTarget | null,
): AgentPhase | null {
  const store = useMemo(
    () => createPhaseStore(target),
    [target?.tenantId, target?.instanceId],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
