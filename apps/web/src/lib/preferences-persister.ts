import { serverPatchForRawChange } from "@workbench/ui";
import { patchMePreferences } from "./hub-api";

const DEBOUNCE_MS = 400;

/**
 * Builds the persister injected into `@workbench/ui`'s preferences store: it maps
 * each raw store change to the server patch shape and flushes a coalesced PATCH
 * after a short debounce, so rapid toggles cost one request. Failures are
 * swallowed — the localStorage cache already reflects the change, and the next
 * write or bootstrap reconciles.
 */
export function createPreferencesPersister(): {
  persist: (key: string, value: string) => void;
  flush: () => void;
} {
  let pending: Record<string, unknown> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const patch = pending;
    pending = {};
    if (Object.keys(patch).length === 0) return;
    void patchMePreferences(patch).catch(() => {});
  }

  function persist(key: string, value: string): void {
    const mapped = serverPatchForRawChange(key, value);
    if (mapped === null) return;
    pending = { ...pending, ...mapped };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  return { persist, flush };
}
