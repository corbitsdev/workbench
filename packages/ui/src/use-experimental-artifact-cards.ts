import { useCallback } from "react";
import {
  PREFERENCE_KEYS,
  setPreference,
  usePreferenceRaw,
} from "./preferences-store";

const STORAGE_KEY = PREFERENCE_KEYS.experimentalArtifactCards;

export function useExperimentalArtifactCards(): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const enabled = raw === "true";

  const setEnabled = useCallback(
    (next: boolean) => setPreference(STORAGE_KEY, String(next)),
    [],
  );

  return { enabled, setEnabled };
}
