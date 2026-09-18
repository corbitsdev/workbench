// Held outside the React tree because the things that open it (Cmd+K, a
// context menu item, the provider) are siblings, not ancestors — one
// store so all three ways in can never disagree.

import { useSyncExternalStore } from "react";

let open = false;
let query = "";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCommandPaletteOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  // A closed palette keeps no query: reopening starts from the default view,
  // never from a stale search someone abandoned.
  if (!next) query = "";
  emit();
}

export function openCommandPalette(): void {
  setCommandPaletteOpen(true);
}

export function closeCommandPalette(): void {
  setCommandPaletteOpen(false);
}

export function setCommandPaletteQuery(next: string): void {
  if (query === next) return;
  query = next;
  emit();
}

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

export function useCommandPaletteQuery(): string {
  return useSyncExternalStore(
    subscribe,
    () => query,
    () => "",
  );
}
