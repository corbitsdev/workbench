// Defense-in-depth against a hostile or careless free-text field riding
// inside the planner prompt. `buildPlannerPrompt` (`./planner-run.ts`)
// sends the whole inventory through `JSON.stringify`, which already
// delimits/escapes every string as a JSON value — the primary,
// already-sound defense against a description breaking OUT of the JSON
// structure it rides in. The residual risk this module blunts is
// narrower: a long block of imperative-sounding text sitting inside a
// legitimately-quoted JSON string field, trying to socially-engineer
// the model reading it. Truncation and newline-stripping meaningfully
// reduce that surface without pretending to eliminate it.

/** Strips newlines/control characters (replaced with a single space,
 * whitespace runs collapsed) and truncates to `maxLen`, so an
 * untrusted description can't pad the prompt with an oversized,
 * multi-line block of imperative text. */
export function sanitizeInventoryText(raw: string, maxLen: number): string {
  const singleLine = raw.replace(/[\r\n\t\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim();
  return singleLine.length > maxLen ? singleLine.slice(0, maxLen) : singleLine;
}
