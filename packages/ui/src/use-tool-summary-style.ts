import { useCallback, useEffect, useState } from 'react';

/**
 * Phrasing for the collapsed tool-activity summary line. Kept in sync with
 * `ToolSummaryStyle` in `@workbench/agents`; this package stays dependency-free,
 * so the union is declared here and validated on read.
 */
export type ToolSummaryStyle = 'symbols' | 'natural' | 'detail' | 'varied' | 'mixed';

const STYLES = new Set<string>(['symbols', 'natural', 'detail', 'varied', 'mixed']);

const STORAGE_KEY = 'cw-tool-summary-style';
const DEFAULT_STYLE: ToolSummaryStyle = 'symbols';

function readStored(): ToolSummaryStyle {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && STYLES.has(stored)) return stored as ToolSummaryStyle;
  } catch {
    // localStorage unavailable (e.g. private mode) — fall through to default.
  }
  return DEFAULT_STYLE;
}

/**
 * Persists the tool-summary phrasing preference. Per-browser via localStorage,
 * mirroring `useTheme`. Defaults to `symbols` (the original compact phrasing).
 */
export function useToolSummaryStyle(): {
  style: ToolSummaryStyle;
  setStyle: (value: ToolSummaryStyle) => void;
} {
  const [style, setStyleState] = useState<ToolSummaryStyle>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, style);
    } catch {
      // Persistence is best-effort; ignore write failures.
    }
  }, [style]);

  const setStyle = useCallback((next: ToolSummaryStyle) => setStyleState(next), []);

  return { style, setStyle };
}
