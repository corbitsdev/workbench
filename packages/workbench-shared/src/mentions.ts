import { type } from "arktype";

// Wire format for a chat mention: `@[Display Name](#usr_<id>)`. The leading
// `#` keeps the token inside markdown's fragment-link scheme, which
// Streamdown's URL sanitizer always treats as safe (a bare `usr_...` href is
// blocked as an unrecognized protocol). The `usr_` prefix is a pill-detection
// marker only, stripped on extraction — it is not part of any stored id.
// `id` is the mentioned member's bare user id (their principal's `refId`, a
// UUID with dashes) — the same id `session.user.id` carries and that
// hub-side lookups (self-skip, `principal.refId` resolution) compare
// against directly. A mailbox address built from a mention re-adds the
// `usr_` prefix at that call site (see apps/hub/src/lib/mention-mail.ts),
// matching the convention in apps/hub/src/lib/principal-mailbox.ts. This
// module only extracts and validates the token shape; tenant scoping and
// mail delivery happen at the hub seam that calls it.
export const MentionSchema = type({
  id: "string",
  name: "string",
});
export type Mention = typeof MentionSchema.infer;

const MENTION_PATTERN = /@\[([^[\]]+)\]\(#usr_([a-zA-Z0-9-]+)\)/g;

/**
 * Extract every `@[Name](#usr_<id>)` mention token from a chat message body.
 * The returned `id` has the `usr_` marker stripped — it is the bare user id.
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

/** Render a mention token for insertion into a chat draft. `id` is the bare user id. */
export function formatMention(id: string, name: string): string {
  return `@[${name}](#usr_${id})`;
}

export type MentionSegment =
  | { type: "text"; value: string }
  | { type: "mention"; id: string; name: string };

/**
 * Split a chat message body into alternating text and mention segments, so a
 * plain-text render surface (no markdown) can still show mentions as pills.
 */
export function splitMentionSegments(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    const id = match[2];
    const index = match.index;
    if (name === undefined || id === undefined || index === undefined) continue;
    if (index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, index) });
    }
    segments.push({ type: "mention", id, name });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}
