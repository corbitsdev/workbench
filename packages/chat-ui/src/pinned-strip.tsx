// The pinned strip: a horizontal row at the top of the channel showing
// every currently-pinned message, each a jump-to-message chip. Renders
// nothing when there are no pins — an empty strip is chrome nobody
// asked to see, the same "no items, no surface" rule the timeline's own
// empty state follows for the reverse case (see `ChannelTimeline`).

import { Pin } from "lucide-react";

import type { PinnedMessage } from "./api";
import { CHAT_STRINGS } from "./strings";

/**
 * A short, single-line preview of a pinned message's content — its
 * first text part, trimmed; falling back to generic copy for a
 * message whose only parts are non-text (a file, a block), since
 * showing raw part data in a preview chip would be more confusing than
 * a plain label.
 */
function previewOf(item: PinnedMessage): string {
  const text = item.parts.find(
    (part): part is Extract<PinnedMessage["parts"][number], { kind: "text" }> =>
      part.kind === "text",
  )?.text;
  if (text === undefined) return CHAT_STRINGS.pinnedStripEmptyPreview;
  const trimmed = text.trim();
  if (trimmed.length === 0) return CHAT_STRINGS.pinnedStripEmptyPreview;
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

export function PinnedStrip({
  items,
  onJump,
}: {
  readonly items: readonly PinnedMessage[];
  /** Scrolls the timeline to the pinned message's own row — the host
   * owns nothing here beyond calling this; `PinnedStrip` resolves the
   * DOM id itself via `messageDomId`. */
  readonly onJump: (messageId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div
      className="chat-pinned-strip"
      role="region"
      aria-label={CHAT_STRINGS.pinnedStripLabel}
    >
      <Pin className="chat-pinned-strip-icon" aria-hidden="true" />
      <div className="chat-pinned-strip-row">
        {items.map((item) => {
          const preview = previewOf(item);
          return (
            <button
              key={item.id}
              type="button"
              className="chat-pinned-strip-item"
              aria-label={CHAT_STRINGS.pinnedStripJumpAction(preview)}
              onClick={() => onJump(item.id)}
            >
              {preview}
            </button>
          );
        })}
      </div>
    </div>
  );
}
