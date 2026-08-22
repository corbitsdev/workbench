// The state of the global command palette (DECISIONS.md → Search) — a
// separate surface from the stage top bar's per-page filter, which owns no
// state here at all. Held outside the React tree because the things that
// open it are siblings, not ancestors: `CommandPaletteProvider` renders the
// palette itself, `Cmd+K` opens it from anywhere via `useCommandShortcut`,
// and a context menu item opens it too. One store, so all three ways in can
// never disagree about whether the palette is open.
//
// Module state outlives a React remount, so search is scoped explicitly:
// `CommandPaletteProvider` closes it on a route change (a Back out of a
// result must not leave the overlay standing) and on a bench switch (whose
// results and query belonged to the bench being left).

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
