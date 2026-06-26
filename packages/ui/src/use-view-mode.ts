import { useCallback } from "react";
import {
  setPreference,
  usePreferenceRaw,
  viewModeStorageKey,
  type ViewModeScope,
} from "./preferences-store";

export type ViewMode = "grid" | "rows";

/**
 * Per-page Grid/Rows layout preference, persisted through the shared
 * preferences store (localStorage cache + debounced server PATCH + bootstrap
 * hydration). Defaults to "grid" — the existing card layout — so a user who
 * never toggles sees no change and no write is made on mount.
 */
export function useViewMode(scope: ViewModeScope): {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
} {
  const key = viewModeStorageKey(scope);
  const raw = usePreferenceRaw(key);
  const mode: ViewMode = raw === "rows" ? "rows" : "grid";

  const setMode = useCallback(
    (next: ViewMode) => setPreference(key, next),
    [key],
  );

  return { mode, setMode };
}
