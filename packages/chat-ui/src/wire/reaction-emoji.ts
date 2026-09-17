// Mirrored from packages/chat/src (CL-8148 T5b): apps/web and @corbits/chat-ui
// must not import @corbits/chat, a server-only package. This is the browser-
// facing half of the same wire contract the hub's chat routes still speak;
// once the hub moves onto native mail threads (T5a/T5c) this file becomes
// the one source of truth and packages/chat's copy goes away.

// The curated set of emoji a message reaction can use — deliberately
// small (Slack's own default quick-react row is the same shape) rather
// than free-form input, so a reaction chip is always one of a handful
// of glyphs a reader recognizes at a glance, never an arbitrary string
// an agent or a client could stuff into the row. Pure data, no drizzle
// import, so both `./routes.ts` (server-side validation) and
// `@corbits/chat-ui` (the picker) import this one list rather than
// keeping two in sync.
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🚀"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export function isKnownReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJI as readonly string[]).includes(value);
}
