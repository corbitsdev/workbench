import { type } from "arktype";

// Wire format for a chat mention: `@[Display Name](#usr_<id>)`. The leading
// `#` keeps the token inside markdown's fragment-link scheme, which
// Streamdown's URL sanitizer always treats as safe (a bare `usr_...` href is
// blocked as an unrecognized protocol). `id` (without the `#`) is the
// mentioned member's user id — the same id that forms the
// `usr_<id>@<tenant domain>` mailbox address (see
// apps/hub/src/lib/principal-mailbox.ts). This module only extracts and
// validates the token shape; tenant scoping and mail delivery happen at the
// hub seam that calls it.
export const MentionSchema = type({
  id: "string",
  name: "string",
});
export type Mention = typeof MentionSchema.infer;

const MENTION_PATTERN = /@\[([^[\]]+)\]\(#(usr_[a-zA-Z0-9]+)\)/g;

/**
 * Extract every `@[Name](#usr_<id>)` mention token from a chat message body.
 * Deduplicates by id, preserving first-seen order and that occurrence's name.
 */
export function extractMentions(text: string): Mention[] {
  const seen = new Map<string, Mention>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    const id = match[2];
    if (name === undefined || id === undefined) continue;
    if (seen.has(id)) continue;
    seen.set(id, { id, name });
  }
  return Array.from(seen.values());
}

/** Render a mention token for insertion into a chat draft. */
export function formatMention(id: string, name: string): string {
  return `@[${name}](#${id})`;
}
