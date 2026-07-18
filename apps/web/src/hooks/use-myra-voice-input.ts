import { useCallback } from "react";
import {
  PREFERENCE_KEYS,
  setPreference,
  usePreferenceRaw,
} from "@workbench/ui";
import { isFeatureEnabled, useMeFeatures } from "./use-me-features";

const STORAGE_KEY = PREFERENCE_KEYS.myraVoiceInput;

/**
 * Per-user Myra composer voice dictation preference, gated by the owner's
 * "voice-input" capability (CL-3909, replacing the former Vite build flag).
 * Defaults on when the capability is enabled; persists opt-out locally only.
 */
export function useMyraVoiceInput(): {
  capabilityEnabled: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const features = useMeFeatures();
  const capabilityEnabled = isFeatureEnabled(features.data, "voice-input");
  const enabled = capabilityEnabled && raw !== "false";

  const setEnabled = useCallback((next: boolean) => {
    setPreference(STORAGE_KEY, String(next));
  }, []);

  return { capabilityEnabled, enabled, setEnabled };
}
