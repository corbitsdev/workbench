import { useCallback } from "react";
import {
  PREFERENCE_KEYS,
  setPreference,
  usePreferenceRaw,
} from "@workbench/ui";
import {
  isMyraVoiceInputBuildEnabled,
  isMyraVoiceInputEnabled,
} from "../lib/myra-voice-input";

const STORAGE_KEY = PREFERENCE_KEYS.myraVoiceInput;

/**
 * Per-user Myra composer voice dictation preference, gated by the build flag.
 * Defaults on when the build supports voice; persists opt-out locally only.
 */
export function useMyraVoiceInput(): {
  buildEnabled: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const buildEnabled = isMyraVoiceInputBuildEnabled();
  const enabled = isMyraVoiceInputEnabled(raw);

  const setEnabled = useCallback((next: boolean) => {
    setPreference(STORAGE_KEY, String(next));
  }, []);

  return { buildEnabled, enabled, setEnabled };
}