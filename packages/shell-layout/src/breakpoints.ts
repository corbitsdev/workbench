// The shell's layout modes and the two widths that separate them, kept free
// of the DOM so the rules stay testable and so `use-shell-layout.ts` is the
// only place that touches `matchMedia`. The sidebar is always present; the
// canvas column is the one region that gives way as the viewport narrows.

export type ShellLayoutMode = "expanded" | "compact" | "narrow";

export const COMPACT_MAX_WIDTH = 1100;
export const NARROW_MAX_WIDTH = 700;

export function shellLayoutModeForWidth(width: number): ShellLayoutMode {
  return shellLayoutModeFromMatches(
    width < NARROW_MAX_WIDTH,
    width < COMPACT_MAX_WIDTH,
  );
}

/** The same rule expressed over media-query results, which is what the shell
 * actually subscribes to at runtime. */
export function shellLayoutModeFromMatches(
  narrow: boolean,
  compact: boolean,
): ShellLayoutMode {
  if (narrow) return "narrow";
  if (compact) return "compact";
  return "expanded";
}

/** The canvas column is the first casualty of a shrinking viewport: it
 * never shows below "expanded", regardless of whether the user asked for
 * it open. */
export function canvasColumnAllowed(mode: ShellLayoutMode): boolean {
  return mode === "expanded";
}
