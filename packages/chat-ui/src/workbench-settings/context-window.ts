// Conversation-memory control's own resolution, independent of React:
// what mode the toggle should show, what value it should PATCH.

export type ContextWindowMode = "inherit" | "override";

/**
 * The two-state control's own resolution, independent of React: what mode
 * the toggle should show and what number the (possibly-disabled) numeric
 * field should display — the "Use bench default (N)" vs override state a
 * workbench's resolved context window folds down to.
 */
export function contextWindowControlState(resolved: {
  readonly value: number;
  readonly source: "inherit" | "override";
}): { readonly mode: ContextWindowMode; readonly displayValue: number } {
  return { mode: resolved.source, displayValue: resolved.value };
}

/**
 * What a context-window edit should PATCH: switching to "inherit" always
 * clears the override back to `null` regardless of whatever the field shows;
 * switching to (or staying on) "override" sends the field's own value,
 * clamped and validated the same way the panel's numeric input already is.
 */
export function contextWindowPatchValue(
  mode: ContextWindowMode,
  overrideValue: number,
): number | null {
  return mode === "inherit" ? null : overrideValue;
}
