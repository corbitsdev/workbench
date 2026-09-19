// An @mention addresses one agent instead of the whole workbench; the token
// stays in the body so the agent reads who was addressed.

export type Mentionable = {
  readonly name: string;
};

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Candidates named by an `@Name` token in `text`, in candidate order. A name
 * nothing in the roster answers to is ignored. */
export function mentionedAgents<T extends Mentionable>(
  text: string,
  candidates: readonly T[],
): readonly T[] {
  // Longest name first, blanking each hit: otherwise "@Writer Two" would
  // also read as a mention of "Writer".
  const byLength = [...candidates].sort((a, b) => b.name.length - a.name.length);
  let remaining = text;
  const found = new Set<T>();
  for (const candidate of byLength) {
    if (candidate.name === "") continue;
    const pattern = new RegExp(`(^|[^\\w@])@${escapeForRegex(candidate.name)}(?![\\w-])`, "gi");
    const blanked = remaining.replace(pattern, (match, lead: string) => {
      found.add(candidate);
      return lead + " ".repeat(match.length - lead.length);
    });
    remaining = blanked;
  }
  return candidates.filter((candidate) => found.has(candidate));
}

export type ActiveMention = {
  /** Offset of the `@` itself, so an insert can replace from there. */
  readonly start: number;
  readonly query: string;
};

/** The mention being typed at `caret`, if any: an `@` that starts a word,
 * followed only by name characters up to the caret. */
export function activeMention(text: string, caret: number): ActiveMention | undefined {
  const before = text.slice(0, caret);
  const match = /(?:^|[^\w@])@([\w-]*)$/.exec(before);
  if (match === null) return undefined;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** `text` with the mention under construction replaced by `@Name `, plus the
 * caret offset that follows it. */
export function applyMention(
  text: string,
  mention: ActiveMention,
  name: string,
  caret: number,
): { readonly text: string; readonly caret: number } {
  const token = `@${name} `;
  return {
    text: `${text.slice(0, mention.start)}${token}${text.slice(caret)}`,
    caret: mention.start + token.length,
  };
}

/** Roster entries whose name matches what has been typed after the `@`. */
export function matchMentionQuery<T extends Mentionable>(
  query: string,
  candidates: readonly T[],
): readonly T[] {
  const needle = query.toLowerCase();
  return candidates.filter((candidate) => candidate.name.toLowerCase().startsWith(needle));
}
