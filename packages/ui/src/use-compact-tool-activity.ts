import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'cw-compact-tools';
const DEFAULT_COMPACT = false;

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage unavailable (e.g. private mode) — fall through to default.
    return DEFAULT_COMPACT;
  }
}

/**
 * Persists the "compact tool activity" preference: when on, a turn's many tool
 * calls collapse into a single summary line in the chat narrative. Per-browser
 * via localStorage, mirroring `useTheme`. Defaults off so nothing changes until
 * opted in.
 */
export function useCompactToolActivity(): {
  compact: boolean;
  setCompact: (value: boolean) => void;
} {
  const [compact, setCompactState] = useState<boolean>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(compact));
    } catch {
      // Persistence is best-effort; ignore write failures.
    }
  }, [compact]);

  const setCompact = useCallback((next: boolean) => setCompactState(next), []);

  return { compact, setCompact };
}
