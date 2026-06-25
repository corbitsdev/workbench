import { useCallback } from "react";
import {
  PREFERENCE_KEYS,
  setPreference,
  usePreferenceRaw,
} from "./preferences-store";

/**
 * Phrasing for the collapsed tool-activity summary line. Kept in sync with
 * `ToolSummaryStyleSchema` in `@workbench/shared` (the server-side validator) and
 * `ToolSummaryStyle` in `@workbench/agents`; this package stays dependency-free,
 * so the union is declared here and validated on read.
 */
export type ToolSummaryStyle =
  | "symbols"
  | "natural"
  | "detail"
  | "varied"
  | "mixed";

const STYLES = new Set<string>([
  "symbols",
  "natural",
  "detail",
  "varied",
  "mixed",
]);

const STORAGE_KEY = PREFERENCE_KEYS.toolSummaryStyle;
const DEFAULT_STYLE: ToolSummaryStyle = "symbols";

function isStyle(value: string | null): value is ToolSummaryStyle {
  return value !== null && STYLES.has(value);
}

/**
 * Persists the tool-summary phrasing preference. Backed by the shared
 * preferences store (localStorage cache + server hydration). Defaults to
 * `symbols` (the original compact phrasing).
 */
export function useToolSummaryStyle(): {
  style: ToolSummaryStyle;
  setStyle: (value: ToolSummaryStyle) => void;
} {
  const raw = usePreferenceRaw(STORAGE_KEY);
  const style = isStyle(raw) ? raw : DEFAULT_STYLE;

  const setStyle = useCallback(
    (next: ToolSummaryStyle) => setPreference(STORAGE_KEY, next),
    [],
  );

  return { style, setStyle };
}
