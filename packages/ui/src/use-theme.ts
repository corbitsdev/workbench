import { useCallback, useEffect } from 'react';
import {
  PREFERENCE_KEYS,
  hydratePreference,
  setPreference,
  usePreferenceRaw,
} from './preferences-store';

// Kept in sync with `ThemeSchema` in `@workbench/shared` (the server-side
// validator on PATCH /me/preferences); this package stays dependency-free, so
// the union is mirrored here rather than imported.
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

const STORAGE_KEY = PREFERENCE_KEYS.theme;
const DEFAULT_THEME: Theme = 'corbits-light';

// Resolves a raw stored value to a current Theme, applying the legacy alias map
// and falling back to the default for unknown/absent values.
function resolveTheme(raw: string | null): Theme {
  if (raw !== null) {
    const migrated = LEGACY_THEME_MAP.get(raw);
    if (migrated !== undefined) return migrated;
    if (isTheme(raw)) return raw;
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const theme = resolveTheme(raw);

  useEffect(() => {
    applyTheme(theme);
    // Canonicalize a *stored* legacy/junk value to its current name without a
    // server echo. Never write on behalf of a user who has no stored value:
    // doing so would persist the default and PATCH it to the server as if it
    // were a deliberate choice. A brand-new user stays unset until they act.
    if (raw !== null && raw !== theme) {
      hydratePreference(STORAGE_KEY, theme);
    }
  }, [raw, theme]);

  const setTheme = useCallback((next: Theme) => setPreference(STORAGE_KEY, next), []);

  return { theme, setTheme };
}
