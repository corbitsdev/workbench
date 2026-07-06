import { useSyncExternalStore } from "react";

/**
 * A tiny module-level pub/sub that lets a workflow-event bubble in the thread
 * ask the workflow dock to surface a given run ("open in dock"), without the
 * bubble reaching into the dock's internals. The bubble publishes a focus
 * request; the dock host (ChatThreadPage) subscribes and reveals the dock. Each
 * request carries a fresh nonce so repeated clicks on the same run re-fire.
 */
export interface DockFocusRequest {
  runId: string;
  nonce: number;
}

let current: DockFocusRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

export function requestDockFocus(runId: string): void {
  nonce += 1;
  current = { runId, nonce };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DockFocusRequest | null {
  return current;
}

export function useDockFocus(): DockFocusRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
