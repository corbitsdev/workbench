// The shell's layout modes and the two widths that separate them, kept free
// of the DOM so the rules stay testable and so `use-shell-layout.ts` is the
// only place that touches `matchMedia`. Three modes, one for each column
// that gives way as the viewport narrows: the canvas column goes first, then
// the contextual column, and the rail is never forced to change (it is
// already as narrow as the shell gets).

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

/** The contextual column (channels/routines/page options) is the second to
 * go — it survives "compact" and only disappears once the shell is
 * "narrow", at which point the rail's own icons are the only navigation. */
export function contextualPanelVisible(mode: ShellLayoutMode): boolean {
  return mode !== "narrow";
}

/** The canvas column is the first casualty of a shrinking viewport: it
 * never shows below "expanded", regardless of whether the user asked for
 * it open. */
export function canvasColumnAllowed(mode: ShellLayoutMode): boolean {
  return mode === "expanded";
}
