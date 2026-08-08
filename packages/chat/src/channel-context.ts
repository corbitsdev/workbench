// Renders the recent channel timeline into a plain-text block prepended
// to a mention fan-out copy, so a mentioned agent sees the conversation
// it is being dropped into rather than only the single message
// addressing it. Kept as a pure formatter, separate from the mail
// loading/decoding it consumes in `routes.ts`'s POST message handler:
// this module never touches `ChatPlatform` or mail shapes, only the
// already-decoded `{ label, text }` pairs the caller assembles.

const CONTEXT_HEADER =
  "[Channel context — the most recent messages in this channel, oldest " +
  "first. The actual message addressed to you follows after this block.]";

/** Per-message truncation length; long messages are summarized to their
 * lead rather than blown out in full, keeping the block scannable. */
const MAX_MESSAGE_LENGTH = 500;

export interface ChannelContextItem {
  /**
   * The sender label to render a message under: `@handle` for an agent
   * participant, or the literal string `"user"` for anything else. Never
   * a raw address or principal id — this text reaches a model prompt and
   * possibly logs.
   */
  readonly label: string;
  readonly text: string;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

/**
 * Renders a plain-text channel context block from oldest-first text
 * messages. Purely a formatter: the caller is responsible for excluding
 * event-kind parts and the just-sent message, for capping `items` to
 * the channel's resolved context-window size before calling, and for
 * skipping the call entirely when `items` is empty (a zero-context send
 * carries no context part at all, identical to today's fan-out copy).
 */
export function renderChannelContext(input: {
  readonly items: readonly ChannelContextItem[];
}): string {
  const lines = input.items.map(
    (item) => `${item.label}: ${truncate(item.text)}`,
  );
  return [CONTEXT_HEADER, ...lines].join("\n");
}

/**
 * Merges a rendered context block into a message's first text part —
 * never as a part of its own. A second part turns the fan-out copy
 * into multipart MIME, and the agent-side mail parser at the current
 * platform version fails the whole run on multipart bodies (the same
 * defect family scripts/repro/WALKPARTS.md documents on the read
 * side); one text part keeps the copy a single text/plain body. A
 * message with no text part gets the context as its leading text part
 * instead — there is nothing to merge into.
 */
export function mergeContextIntoParts<T extends { kind: string }>(
  contextText: string,
  parts: readonly T[],
): readonly (T | { kind: "text"; text: string })[] {
  const firstTextAt = parts.findIndex((part) => part.kind === "text");
  if (firstTextAt === -1) {
    return [{ kind: "text", text: contextText }, ...parts];
  }
  return parts.map((part, index) =>
    index === firstTextAt
      ? {
          kind: "text",
          text: `${contextText}\n\n${(part as T & { text: string }).text}`,
        }
      : part,
  );
}
