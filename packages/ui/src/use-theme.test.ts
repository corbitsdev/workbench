import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { isTheme, THEMES, useTheme } from './use-theme';
import { setPreferencePersister } from './preferences-store';

const STORAGE_KEY = 'cw-theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setPreferencePersister(null);
});

afterEach(() => {
  localStorage.clear();
  setPreferencePersister(null);
});

describe('THEMES / isTheme', () => {
  it('includes all four brand themes', () => {
    expect(THEMES).toContain('corbits-dark');
    expect(THEMES).toContain('corbits-light');
    expect(THEMES).toContain('tkww');
    expect(THEMES).toContain('notion');
  });

  it('isTheme returns true for valid theme values', () => {
    for (const t of THEMES) {
      expect(isTheme(t)).toBe(true);
    }
  });

  it('isTheme returns false for invalid values', () => {
    expect(isTheme('dark')).toBe(false);
    expect(isTheme('light')).toBe(false);
    expect(isTheme('system')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });
});

describe('useTheme', () => {
  it('defaults to corbits-light and applies it to the document on mount', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('corbits-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('corbits-light');
  });

  it('does not write to localStorage on mount when nothing is stored', () => {
    renderHook(() => useTheme());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not PATCH the server on first mount with empty storage', () => {
    const persist = mock((_k: string, _v: string) => {});
    setPreferencePersister(persist);
    renderHook(() => useTheme());
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not write when a valid value is already stored (no echo)', () => {
    localStorage.setItem(STORAGE_KEY, 'tkww');
    let writes = 0;
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k: string, v: string) => {
      writes += 1;
      original(k, v);
    };
    try {
      renderHook(() => useTheme());
    } finally {
      localStorage.setItem = original;
    }
    expect(writes).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('tkww');
  });

  it('reads a valid persisted corbits-light theme on init', () => {
    localStorage.setItem(STORAGE_KEY, 'corbits-light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('corbits-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('corbits-light');
  });

  it('reads a valid persisted tkww theme on init', () => {
    localStorage.setItem(STORAGE_KEY, 'tkww');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('tkww');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tkww');
  });

  it('reads a valid persisted notion theme on init', () => {
    localStorage.setItem(STORAGE_KEY, 'notion');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('notion');
    expect(document.documentElement.getAttribute('data-theme')).toBe('notion');
  });

  it('migrates legacy "dark" value to corbits-dark', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('corbits-dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('corbits-dark');
  });

  it('migrates legacy "light" value to corbits-light', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('corbits-light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('corbits-light');
  });

  it('ignores an unknown persisted value and falls back to corbits-light', () => {
    localStorage.setItem(STORAGE_KEY, 'neon');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('corbits-light');
  });

  it('updates the document and persists when setTheme is called', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('tkww'));
    expect(result.current.theme).toBe('tkww');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tkww');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('tkww');
  });

  it('can cycle through all four themes', () => {
    const { result } = renderHook(() => useTheme());
    for (const t of THEMES) {
      act(() => result.current.setTheme(t));
      expect(result.current.theme).toBe(t);
      expect(document.documentElement.getAttribute('data-theme')).toBe(t);
    }
  });
});
