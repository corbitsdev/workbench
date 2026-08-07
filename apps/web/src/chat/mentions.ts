// Pure @-mention logic for the composer: detecting an in-progress mention at
// the caret, filtering the agent list against it, and splicing a chosen name
// back into the draft. No DOM, no fetch — kept pure so it is unit-testable
// without mounting anything.

export type MentionCandidate = {
  readonly id: string;
  readonly name: string;
};

export type MentionQuery = {
  /** Index of the "@" that opened this mention, for splicing the result back in. */
  readonly start: number;
  /** Text typed after the "@" so far. */
  readonly query: string;
};

/**
 * Looks backward from the caret for an open "@mention": an "@" not
 * preceded by a word character, with no whitespace between it and the
 * caret. Returns `null` when the caret is not inside one — including right
 * after a mention that was closed by a space.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? "" : upToCaret[at - 1];
  if (before !== undefined && /\S/.test(before)) return null;
  const query = upToCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * Agents whose name starts with the query, case-insensitively. An empty
 * query matches everyone — the popover opens on a bare "@".
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): readonly MentionCandidate[] {
  const needle = query.toLowerCase();
  return candidates.filter((candidate) =>
    candidate.name.toLowerCase().startsWith(needle),
  );
}

/**
 * Replaces the open "@query" at `mention.start` with "@name " (trailing
 * space, so typing continues past the mention rather than into it) and
 * returns the new text plus where the caret lands.
 */
export function insertMention(
  text: string,
  caret: number,
  mention: MentionQuery,
  name: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const inserted = `@${name} `;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
