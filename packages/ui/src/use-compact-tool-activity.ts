import { useCallback } from 'react';
import { PREFERENCE_KEYS, setPreference, usePreferenceRaw } from './preferences-store';

const STORAGE_KEY = PREFERENCE_KEYS.compactToolActivity;

/**
 * Persists the "compact tool activity" preference: when on, a turn's many tool
 * calls collapse into a single summary line in the chat narrative. Backed by the
 * shared preferences store (localStorage cache + server hydration). Defaults off
 * so nothing changes until opted in.
 */
export function useCompactToolActivity(): {
  compact: boolean;
  setCompact: (value: boolean) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  // Default off. Any non-`'true'` stored value (including absent) reads as off,
  // so there is nothing to canonicalize — never write on mere mount, which would
  // persist the default for a user who never opted in.
  const compact = raw === 'true';

  const setCompact = useCallback((next: boolean) => setPreference(STORAGE_KEY, String(next)), []);

  return { compact, setCompact };
}
