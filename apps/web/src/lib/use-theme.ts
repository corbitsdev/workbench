import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cw-theme';
const DEFAULT_THEME: Theme = 'dark';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (e.g. private mode) — fall through to default.
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Light/dark theme with localStorage persistence, mirroring workbench.html.
 * Sets `data-theme` on <html>; the palette swap lives in index.css.
 */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; ignore write failures.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  return { theme, setTheme };
}
