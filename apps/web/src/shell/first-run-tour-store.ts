// The first-run tour's open state, held outside the React tree like
// `command-palette-open-store.ts`: the tour must never auto-start itself on
// landing (it used to, and its overlay would land right over the chat the
// person was just redirected onto), so the only way in is an explicit call
// to `openFirstRunTour` from a command or menu action.

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
