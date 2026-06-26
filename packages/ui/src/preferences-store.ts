import { type } from "arktype";
import { useSyncExternalStore } from "react";

/**
 * A tiny reactive store for per-user UI preferences, backed by localStorage so
 * the first paint is synchronous (no theme flash) and shared across every hook
 * that reads a key. Server values hydrate in after bootstrap via
 * {@link hydratePreference}; user edits go through {@link setPreference}, which
 * also notifies an injected persister so the durable (DB) write stays in the app
 * layer — this package never talks to the network.
 *
 * Values are stored as raw strings (the localStorage medium); each consuming
 * hook owns its own (de)serialization and defaults.
 */

/** localStorage keys for the known preferences (also the store's cache keys). */
export const PREFERENCE_KEYS = {
  theme: "cw-theme",
  compactToolActivity: "cw-compact-tools",
  toolSummaryStyle: "cw-tool-summary-style",
  archivedWorkflowRuns: "cw-archived-workflow-runs",
} as const;

// Parses the JSON-encoded string-array stored under a list-valued preference,
// degrading a malformed/legacy blob to an empty list rather than throwing.
export function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

type Persister = (key: string, value: string) => void;

let persister: Persister | null = null;

/** Apps inject how a changed preference is persisted server-side (debounced PATCH). */
export function setPreferencePersister(fn: Persister | null): void {
  persister = fn;
}

// Per-key subscriber sets: a write to one key only re-renders hooks reading that
// key, not every preference consumer.
const listenersByKey = new Map<string, Set<() => void>>();

function notify(key: string): void {
  const set = listenersByKey.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listenersByKey.get(key);
  if (!set) {
    set = new Set();
    listenersByKey.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listenersByKey.delete(key);
  };
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence to localStorage is best-effort (e.g. private mode).
  }
}

/** Reactively read a preference's raw string value (null when unset). */
export function usePreferenceRaw(key: string): string | null {
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => readRaw(key),
    () => null,
  );
}

/** Read once outside React (e.g. to apply a default on first set). */
export function getPreferenceRaw(key: string): string | null {
  return readRaw(key);
}

/** User edit: write localStorage, notify readers, and persist server-side. */
export function setPreference(key: string, value: string): void {
  writeRaw(key, value);
  notify(key);
  persister?.(key, value);
}

/**
 * Reconcile a server-sourced value into the store WITHOUT re-persisting it
 * (avoids an echo write). No-op when the value already matches, so it never
 * causes a needless re-render.
 */
export function hydratePreference(key: string, value: string): void {
  if (readRaw(key) === value) return;
  writeRaw(key, value);
  notify(key);
}

/** Server bootstrap shape — structurally the shared `MemberPreferences`. */
export const ServerPreferencesSchema = type({
  "theme?": "string",
  "compactToolActivity?": "boolean",
  "toolSummaryStyle?": "string",
  "archivedWorkflowRuns?": "string[]",
});

export type ServerPreferences = typeof ServerPreferencesSchema.infer;

/** Reconcile the server's persisted preferences into the store after bootstrap. */
export function hydrateServerPreferences(prefs: unknown): void {
  const parsed = ServerPreferencesSchema(prefs);
  if (parsed instanceof type.errors) return;
  if (parsed.theme !== undefined)
    hydratePreference(PREFERENCE_KEYS.theme, parsed.theme);
  if (parsed.compactToolActivity !== undefined) {
    hydratePreference(
      PREFERENCE_KEYS.compactToolActivity,
      String(parsed.compactToolActivity),
    );
  }
  if (parsed.toolSummaryStyle !== undefined) {
    hydratePreference(
      PREFERENCE_KEYS.toolSummaryStyle,
      parsed.toolSummaryStyle,
    );
  }
  if (parsed.archivedWorkflowRuns !== undefined) {
    hydratePreference(
      PREFERENCE_KEYS.archivedWorkflowRuns,
      JSON.stringify(parsed.archivedWorkflowRuns),
    );
  }
}

/**
 * Maps a raw store change to the server patch shape for the injected persister,
 * keeping (de)serialization in one place. Returns null for keys with no server
 * mapping (purely-local prefs).
 */
export function serverPatchForRawChange(
  key: string,
  value: string,
): Record<string, unknown> | null {
  if (key === PREFERENCE_KEYS.theme) return { theme: value };
  if (key === PREFERENCE_KEYS.compactToolActivity) {
    return { compactToolActivity: value === "true" };
  }
  if (key === PREFERENCE_KEYS.toolSummaryStyle)
    return { toolSummaryStyle: value };
  if (key === PREFERENCE_KEYS.archivedWorkflowRuns)
    return { archivedWorkflowRuns: parseStringList(value) };
  return null;
}
