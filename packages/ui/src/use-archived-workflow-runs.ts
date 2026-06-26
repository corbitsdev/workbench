import { useCallback, useMemo } from "react";
import {
  PREFERENCE_KEYS,
  getPreferenceRaw,
  parseStringList,
  setPreference,
  usePreferenceRaw,
} from "./preferences-store";

const STORAGE_KEY = PREFERENCE_KEYS.archivedWorkflowRuns;

/**
 * Persists the set of workflow run ids the member has archived (hidden) from the
 * runs list. Backed by the shared preferences store (localStorage cache + server
 * hydration), stored as a JSON string array. Archiving is purely a view choice —
 * the run record itself is untouched — so the list filters these out by default
 * with an explicit affordance to view them.
 */
export function useArchivedWorkflowRuns(): {
  archived: ReadonlySet<string>;
  isArchived: (runId: string) => boolean;
  setArchived: (runId: string, archived: boolean) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const archived = useMemo(() => new Set(parseStringList(raw)), [raw]);

  const isArchived = useCallback(
    (runId: string) => archived.has(runId),
    [archived],
  );

  // Read the current value fresh (not from the memoized snapshot) so rapid
  // toggles never write a stale set back over an interleaved change.
  const setArchived = useCallback((runId: string, next: boolean) => {
    const current = new Set(parseStringList(getPreferenceRaw(STORAGE_KEY)));
    if (next) current.add(runId);
    else current.delete(runId);
    setPreference(STORAGE_KEY, JSON.stringify([...current]));
  }, []);

  return { archived, isArchived, setArchived };
}
