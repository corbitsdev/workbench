// The theme lives outside React: `data-theme` on <html> is the one switch,
// and this store is its only writer. Light is explicit too: react-ui's
// `prefers-color-scheme: dark` block only skips roots carrying `.light`.

import { reportError } from "@corbits/error-sink";
import { useSyncExternalStore } from "react";

export const THEMES = ["light", "dark", "canvas"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

const DEFAULT_KEY = "corbits-theme";
// Unscoped copy of the last-set theme; the boot script in index.html reads it.
const LAST_KEY = "corbits-theme:last";

let storageKey = DEFAULT_KEY;
let current: Theme = "light";
const listeners = new Set<() => void>();

function readStored(key: string): Theme {
  try {
    const raw = window.localStorage.getItem(key);
    return isTheme(raw) ? raw : "light";
  } catch (error) {
    reportError(error, { operation: "theme_read" });
    return "light";
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  // react-ui's `dark:` variant keys off `.dark`; its OS-dark block excludes `.light`.
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme !== "dark");
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
}

function commit(theme: Theme) {
  current = theme;
  apply(theme);
  for (const listener of listeners) listener();
}

/** Point the store at a per-user key and adopt whatever that key holds. */
export function setThemeStorageKey(key: string) {
  if (key !== storageKey) {
    storageKey = key;
    commit(readStored(key));
  }
}

export function setTheme(theme: Theme) {
  commit(theme);
  try {
    window.localStorage.setItem(storageKey, theme);
    window.localStorage.setItem(LAST_KEY, theme);
  } catch (error) {
    reportError(error, { operation: "theme_persist" });
  }
}

export function cycleTheme() {
  const index = THEMES.indexOf(current);
  setTheme(THEMES[(index + 1) % THEMES.length] ?? "light");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}

// First paint uses the signed-out key; the session key takes over once known.
if (typeof document !== "undefined") commit(readStored(storageKey));
