// The in-progress agent reply, streamed token-by-token: `chat.agent` SSE
// events already carry the vendored Interchange `InferenceEvent` union
// verbatim (see `packages/chat/src/platform-adapter.ts`'s
// `subscribeToChannel`, which wraps `sidecarRouter.subscribeAgent`'s raw
// callback payload with no filtering) — this module is the trust boundary
// that narrows that `unknown` payload and the pure state machine that turns
// a run of `inference.text.delta` events into one growing string.
//
// `inference.text.delta`'s `data.partial.text` is already cumulative (see
// `PartialMessage` in `vendor/intx/types/src/runtime.ts`) — each delta is
// "all text streamed so far," not just the new token — so this module never
// concatenates fragments itself; it just takes the latest one.

import { useEffect, useState } from "react";

import { isAgentAddress } from "@corbits/chat/mentions";
import type { ParticipantRecord } from "./api";

export type StreamingReplyState = { readonly text: string } | null;

type InferenceDeltaEvent = {
  readonly type: "inference.text.delta";
  readonly data: { readonly partial: { readonly text: string } };
};

/** Narrows a `chat.agent` payload down to the one inner event shape this
 * module cares about — every other `InferenceEvent` variant (tool calls,
 * thinking, usage, `inference.start`) is read as its bare `type` string
 * only, never assumed to carry a `partial.text`. */
function parseInferenceDeltaEvent(data: unknown): InferenceDeltaEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "inference.text.delta") return null;
  const inner = record.data;
  if (typeof inner !== "object" || inner === null) return null;
  const partial = (inner as Record<string, unknown>).partial;
  if (typeof partial !== "object" || partial === null) return null;
  const text = (partial as Record<string, unknown>).text;
  if (typeof text !== "string") return null;
  return { type: "inference.text.delta", data: { partial: { text } } };
}

/** The bare `type` discriminant of a `chat.agent` payload, for the two
 * variants that end a turn — read without narrowing the rest of the event,
 * since neither carries (or needs) a `partial.text`. */
function innerEventType(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

/**
 * The streaming reply's whole state machine, pure: an `inference.start`
 * opens an empty in-progress reply, each `inference.text.delta` replaces it
 * with that delta's cumulative text, and `inference.done`/`inference.error`
 * clear it — the turn is over, and the real persisted message (fetched by
 * the same refetch every non-typing `chat.agent` event already triggers)
 * takes over from here. Every other event type (tool calls, thinking,
 * usage) leaves the current state untouched. Kept separate from the
 * `useState` that holds it in `useStreamingReply` so the rule is testable
 * without mounting anything, matching `nextTypingState`'s split in
 * `typing-indicator.tsx`.
 */
export function nextStreamingReplyState(
  current: StreamingReplyState,
  event: { readonly eventType: string; readonly data: unknown },
): StreamingReplyState {
  if (event.eventType !== "chat.agent") return current;

  const innerType = innerEventType(event.data);
  if (innerType === "inference.start") return { text: "" };
  if (innerType === "inference.done" || innerType === "inference.error") {
    return null;
  }

  const delta = parseInferenceDeltaEvent(event.data);
  if (delta === null) return current;
  return { text: delta.data.partial.text };
}

/**
 * Owns the streaming reply's state end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all, same as
 * `useTypingIndicator`) and it tracks the active turn's growing text,
 * clearing itself the moment the turn ends. `channelId` resets it
 * immediately on a channel switch, same reasoning as
 * `useTypingIndicator` — an in-progress reply from the channel just left
 * belongs to that channel's timeline, not the new one.
 */
export function useStreamingReply(channelId: string | null): {
  readonly streamingReply: StreamingReplyState;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [streamingReply, setStreamingReply] =
    useState<StreamingReplyState>(null);

  useEffect(() => {
    setStreamingReply(null);
  }, [channelId]);

  function handleStreamEvent(eventType: string, data: unknown) {
    setStreamingReply((current) =>
      nextStreamingReplyState(current, { eventType, data }),
    );
  }

  return { streamingReply, handleStreamEvent };
}

/**
 * The handle(s) to show as "typing" above the composer while a turn
 * streams — mirrors `mergeStreamingReply`'s attribution exactly (the
 * channel's first agent participant), since a `chat.agent` event carries no
 * sender of its own. Channels with more than one invited agent are the
 * same known approximation `mergeStreamingReply` already documents, not a
 * new gap: only the streaming turn's actual agent can be named once the
 * wire event carries one.
 */
export function typingAgentNames(
  streamingReply: StreamingReplyState,
  participants: readonly ParticipantRecord[],
): readonly string[] {
  if (streamingReply === null) return [];
  const agent = participants.find((participant) =>
    isAgentAddress(participant.address),
  );
  return agent === undefined ? [] : [agent.handle];
}
