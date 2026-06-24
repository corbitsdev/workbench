import { useCallback, useEffect, useState } from 'react';

export type Theme = 'corbits-dark' | 'corbits-light' | 'tkww' | 'notion';

export const THEMES: readonly Theme[] = ['corbits-dark', 'corbits-light', 'tkww', 'notion'];

export const THEME_LABELS: Readonly<Record<Theme, string>> = {
  'corbits-dark': 'Corbits Dark',
  'corbits-light': 'Corbits Light',
  tkww: 'TKWW',
  notion: 'Notion',
};

const THEMES_SET = new Set<string>(THEMES);

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES_SET.has(value);
}

// Maps legacy stored values to their current Theme equivalents.
const LEGACY_THEME_MAP = new Map<string, Theme>([
  ['dark', 'corbits-dark'],
  ['light', 'corbits-light'],
]);

const STORAGE_KEY = 'cw-theme';
const DEFAULT_THEME: Theme = 'corbits-light';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const migrated = LEGACY_THEME_MAP.get(stored);
      const theme = migrated ?? (isTheme(stored) ? stored : null);
      if (theme !== null) {
        // Write back immediately so the stored value is always a current Theme name.
        localStorage.setItem(STORAGE_KEY, theme);
        return theme;
      }
    }
  } catch {
    // localStorage unavailable (e.g. private mode) — fall through to default.
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

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
