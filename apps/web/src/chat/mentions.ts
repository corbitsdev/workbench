// Pure @-mention logic for the composer: detecting an in-progress mention at
// the caret, deriving mentionable candidates from a channel's participants,
// filtering them against the query, and splicing a chosen handle back into
// the draft. No DOM, no fetch — kept pure so it is unit-testable without
// mounting anything.
//
// The inserted text must match the server's matching semantics
// (`mentionedParticipants` in packages/chat/src/routes.ts): it looks for
// `@<local part of the participant's address>` in the message text. So the
// candidate's `handle` — the text actually spliced in — is always the local
// part of an agent address, never a display name; `label` is a friendlier
// string shown alongside it in the popover only.

export type MentionCandidate = {
  readonly id: string;
  readonly handle: string;
  readonly label: string;
};

function isAgentAddress(participant: string): boolean {
  return participant.includes("@");
}

function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

/**
 * A softer label for a handle like `launch-planner` or `qa_bot`:
 * word-separators become spaces and each word is capitalized, giving
 * "Launch Planner" — falls back to the raw handle when that would be empty.
 */
function readableLabel(handle: string): string {
  const words = handle.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return handle;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The mentionable candidates for a channel: its agent-address participants
 * (the same set `mentionedParticipants` fans a copy to on the server), each
 * keyed by the local part of its address so a picked candidate always
 * inserts text the server will actually match.
 */
export function mentionCandidatesFromParticipants(
  participants: readonly string[],
): readonly MentionCandidate[] {
  return participants.filter(isAgentAddress).map((address) => {
    const handle = localPartOf(address);
    return { id: address, handle, label: readableLabel(handle) };
  });
}

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
 * Candidates whose handle or label starts with the query, case-insensitively
 * — matching on the label too so typing a readable prefix still finds the
 * handle it would insert. An empty query matches everyone — the popover
 * opens on a bare "@".
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): readonly MentionCandidate[] {
  const needle = query.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.handle.toLowerCase().startsWith(needle) ||
      candidate.label.toLowerCase().startsWith(needle),
  );
}

/**
 * Replaces the open "@query" at `mention.start` with "@handle " (trailing
 * space, so typing continues past the mention rather than into it) and
 * returns the new text plus where the caret lands. `handle` must be the
 * local part of the mentioned participant's address — see the module note
 * above — never a display name.
 */
export function insertMention(
  text: string,
  caret: number,
  mention: MentionQuery,
  handle: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const inserted = `@${handle} `;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
