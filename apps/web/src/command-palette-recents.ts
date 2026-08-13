// A localStorage-backed Recents store per bench, built on
// `@corbits/command-palette`'s generic `createRecentsStore`. Mirrors the
// defensive try/catch localStorage access `bench-context.tsx` already uses —
// a private-browsing tab with storage disabled loses persistence, not
// function.

import {
  createRecentsStore,
  type RecentsStorage,
  type RecentsStore,
} from "@corbits/command-palette";

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
