// The in-progress agent reply, streamed token-by-token: `chat.agent` SSE
// events already carry the vendored Interchange `InferenceEvent` union
// verbatim (see `packages/chat/src/platform-adapter.ts`'s
// `subscribeToWorkbench`, which wraps `sidecarRouter.subscribeAgent`'s raw
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
import { displayNameFromHandle } from "./timeline";

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
 * opens an empty in-progress reply if nothing is showing yet (it never
 * wipes tokens already streamed), each `inference.text.delta` replaces it
 * with that delta's cumulative text, and `reactor.done`/`reactor.error`
 * clear it — the turn is over. `inference.done` only clears once tokens
 * have streamed (the persisted message takes over); an empty pending
 * survives so the typing pulse stays up across tool rounds. `inference.error`
 * always clears. Every other event type (tool calls, thinking, usage)
 * leaves the current state untouched.
 */
export function nextStreamingReplyState(
  current: StreamingReplyState,
  event: { readonly eventType: string; readonly data: unknown },
): StreamingReplyState {
  if (event.eventType !== "chat.agent") return current;

  const innerType = innerEventType(event.data);
  if (innerType === "inference.start") return current ?? { text: "" };
  // `reactor.start` is the earliest "the agent is on it" signal — it
  // fires before any tokens, often seconds before a slow model's
  // `inference.start` — so it opens the indicator without waiting for
  // the first inference call.
  if (innerType === "reactor.start") return current ?? { text: "" };
  if (innerType === "reactor.done" || innerType === "reactor.error") {
    return null;
  }
  if (innerType === "inference.error") return null;
  if (innerType === "inference.done") {
    return current === null || current.text === "" ? (current ?? { text: "" }) : null;
  }

  const delta = parseInferenceDeltaEvent(event.data);
  if (delta === null) return current;
  return { text: delta.data.partial.text };
}

/**
 * Owns the streaming reply's state end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all, same as
 * `useTypingIndicator`) and it tracks the active turn's growing text,
 * clearing itself the moment the turn ends. `workbenchId` resets it
 * immediately on a workbench switch, same reasoning as
 * `useTypingIndicator` — an in-progress reply from the workbench just left
 * belongs to that workbench's timeline, not the new one.
 */
/**
 * Opens an empty pending reply without an agent event: the caller just
 * sent a message to a workbench with an agent in it, so a reply is owed
 * even though no `reactor.start` has streamed yet. Never resets a reply
 * already streaming.
 */
export function openPendingReply(
  current: StreamingReplyState,
): StreamingReplyState {
  return current ?? { text: "" };
}

/** How long an empty pending reply may sit with no tokens before the
 * indicator clears itself — the backstop for a turn whose stream events
 * never arrive (agent down, SSE dropped mid-reconnect). */
const PENDING_REPLY_CLEAR_MS = 120_000;

export function useStreamingReply(
  workbenchId: string | null,
  clearMs: number = PENDING_REPLY_CLEAR_MS,
): {
  readonly streamingReply: StreamingReplyState;
  /** True once the backstop above has fired for the turn just cleared —
   * the host's cue to render `CHAT_STRINGS.replyTimedOutNotice` rather
   * than silently dropping back to no indicator at all. Reset on the
   * next workbench switch, stream event, or awaited reply, same lifecycle
   * as `streamingReply` itself. */
  readonly replyTimedOut: boolean;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
  readonly noteAwaitingReply: () => void;
} {
  const [streamingReply, setStreamingReply] =
    useState<StreamingReplyState>(null);
  const [replyTimedOut, setReplyTimedOut] = useState(false);

  useEffect(() => {
    setStreamingReply(null);
    setReplyTimedOut(false);
  }, [workbenchId]);

  useEffect(() => {
    if (streamingReply === null || streamingReply.text !== "") return;
    const timer = setTimeout(() => {
      // The dependency below re-arms this effect (clearing this exact
      // timer) the instant `streamingReply` changes, so this callback only
      // ever runs while it's still the same pending reply it was armed
      // for — no need to re-check identity here.
      setStreamingReply(null);
      setReplyTimedOut(true);
    }, clearMs);
    return () => clearTimeout(timer);
  }, [streamingReply, clearMs]);

  function handleStreamEvent(eventType: string, data: unknown) {
    setReplyTimedOut(false);
    setStreamingReply((current) =>
      nextStreamingReplyState(current, { eventType, data }),
    );
  }

  function noteAwaitingReply() {
    setReplyTimedOut(false);
    setStreamingReply(openPendingReply);
  }

  return {
    streamingReply,
    replyTimedOut,
    handleStreamEvent,
    noteAwaitingReply,
  };
}

/**
 * The handle(s) to show as "typing" in the incoming-message slot while a reply is
 * owed but no tokens have streamed yet — mirrors `mergeStreamingReply`'s
 * attribution exactly (the
 * workbench's first agent participant), since a `chat.agent` event carries no
 * sender of its own. Workbenches with more than one invited agent are the
 * same known approximation `mergeStreamingReply` already documents, not a
 * new gap: only the streaming turn's actual agent can be named once the
 * wire event carries one.
 */
export function typingAgentNames(
  streamingReply: StreamingReplyState,
  participants: readonly ParticipantRecord[],
): readonly string[] {
  // Only the tokenless pending phase shows the typing line; once text
  // streams, the growing timeline bubble is the signal — showing both
  // would double-indicate the same turn.
  if (streamingReply === null || streamingReply.text !== "") return [];
  const agent = participants.find((participant) =>
    isAgentAddress(participant.address),
  );
  return agent === undefined ? [] : [displayNameFromHandle(agent.handle)];
}
