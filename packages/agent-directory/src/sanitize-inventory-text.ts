// Defense-in-depth against a hostile or careless free-text field riding
// inside the planner prompt: `JSON.stringify` already prevents breaking out
// of the JSON structure, but a long imperative block can still sit inside a
// legitimately-quoted string trying to socially-engineer the model.

/** Strips newlines/control characters to a single space and truncates to
 * `maxLen`. */
export function sanitizeInventoryText(raw: string, maxLen: number): string {
  const singleLine = raw
    .replace(/[\r\n\t\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > maxLen ? singleLine.slice(0, maxLen) : singleLine;
}
