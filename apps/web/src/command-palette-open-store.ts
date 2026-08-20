// The state of the product's single search surface (DESIGN.md → Search),
// held outside the React tree because the surfaces that read and write it are
// siblings, not ancestors: `CommandPaletteProvider` renders the palette,
// `StageTopBar`'s magnifier morphs into it, and a context menu item opens it,
// and app.tsx's Shell mounts the first two side by side. One store, so the
// morph and the palette can never disagree about whether search is open, and
// so cmd+K, the magnifier, and a menu item all drive the same surface.

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

export function toggleCommandPalette(): void {
  setCommandPaletteOpen(!open);
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
