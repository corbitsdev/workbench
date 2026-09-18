// Defensive try/catch localStorage access: a private-browsing tab with
// storage disabled loses persistence, not function.

import { createRecentsStore, type RecentsStorage, type RecentsStore } from "@/command-palette";

const STORAGE_PREFIX = "workbench.cmdk-recents";

const safeLocalStorage: RecentsStorage = {
  getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage disabled or full — recents just stop persisting this tab.
    }
  },
};

/** One Recents store per bench, so switching benches never mixes histories. */
export function recentsStoreForBench(tenantId: string): RecentsStore {
  return createRecentsStore(safeLocalStorage, `${STORAGE_PREFIX}:${tenantId}`);
}
