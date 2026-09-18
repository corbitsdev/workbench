// Must never auto-start on landing (it used to, overlaying the chat the
// person was just redirected onto) — only an explicit call opens it.

import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openFirstRunTour(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeFirstRunTour(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useFirstRunTourOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
