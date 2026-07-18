// SQL LIKE treats `\`, `%`, and `_` as metacharacters. Every LIKE pattern
// built from an id (rather than a literal, hand-written pattern) must escape
// them first, or an id containing one of these characters silently changes
// what the pattern matches. `\` is escaped first — escaping it after `%`/`_`
// would double-escape the backslashes those substitutions just introduced.
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
