// The preferences key col2's collapse choice is persisted under, and the
// pure read of it back out of a fetched preferences bag — kept separate
// from ShellChromeProvider so the hydration rule is unit-testable without
// mounting the provider's full context tree.

export const COL2_COLLAPSED_PREFERENCE_KEY = "shell.col2Collapsed";

/** Only an explicit `true` hydrates as collapsed — any other stored value
 * (absent, `false`, or a foreign shape from a future key change) defaults
 * to open, matching `userCollapsedCol2`'s own `useState(false)` default. */
export function col2CollapsedFromPreferences(
  preferences: Record<string, unknown>,
): boolean {
  return preferences[COL2_COLLAPSED_PREFERENCE_KEY] === true;
}
