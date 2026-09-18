// Defense-in-depth against a free-text field riding inside the planner
// prompt: a quoted string can still carry an imperative block.

/** Strips newlines/control characters to a single space and truncates to
 * `maxLen`. */
export function sanitizeInventoryText(raw: string, maxLen: number): string {
  const singleLine = raw
    .replace(/[\r\n\t\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > maxLen ? singleLine.slice(0, maxLen) : singleLine;
}
