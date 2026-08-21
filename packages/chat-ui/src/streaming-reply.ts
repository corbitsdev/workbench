// The in-progress agent reply, streamed token-by-token: `chat.agent` SSE
// events already carry the vendored Interchange `InferenceEvent` union
// verbatim (see `packages/chat/src/platform-adapter.ts`'s
// `subscribeToWorkbench`, which wraps `sidecarRouter.subscribeAgent`'s raw
// callback payload with no filtering) — this module is the trust boundary
// that narrows that `unknown` payload and the pure state machine that turns
// a run of `inference.text.delta` events into one growing string.
//
// `inference.text.delta`'s `data.partial.text` is already cumulative (see
// `PartialMessage` in `@intx/types/src/runtime.ts`) — each delta is
// "all text streamed so far," not just the new token — so this module never
// concatenates fragments itself; it just takes the latest one.

import { useEffect, useRef, useState } from "react";

import { isAgentAddress } from "@corbits/chat/mentions";
import type { ParticipantRecord } from "./api";
import { displayNameFromHandle } from "./timeline";

/**
 * The current turn's reply state, phase-tagged (CL-6432 reopened):
 *
 * - `"awaiting"` — a turn is in flight and its visible reply hasn't posted
 *   yet: an empty `text` renders the typing pulse, streamed tokens render
 *   the growing bubble.
 * - `"replied"` — this turn's `connector.reply` has posted. A live folded
 *   run PARKS after the turn (no `message.run.ended`), and its post-reply
 *   tool-only rounds (memory writes) still emit `inference.start`/
 *   `inference.done` — none of which may re-open the pulse. Renders
 *   nothing; only a genuinely new turn leaves it.
 * - `null` — idle, no turn in flight.
 */
export type StreamingReplyState =
  | { readonly phase: "awaiting"; readonly text: string }
  | { readonly phase: "replied" }
  | null;

const REPLIED: StreamingReplyState = { phase: "replied" };

function awaiting(text: string): StreamingReplyState {
  return { phase: "awaiting", text };
}

/** Whether the state renders the tokenless typing pulse. The `"replied"`
 * phase is deliberately not pending — it renders nothing and must never
 * arm the pending-timeout backstop. */
export function isPendingReply(state: StreamingReplyState): boolean {
  return state !== null && state.phase === "awaiting" && state.text === "";
}

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

/** Whether a `chat.message` payload carries `postUndeliveredNotice`'s
 * `turnFailed` part (see `packages/chat/src/workbench-service.ts`). This
 * notice posts straight to the room with no `chat.agent` events at all —
 * the dispatch failed before `sendMail` ever reached the agent — so
 * without this check a turn that fails this way never emits the
 * `reactor.error`/`inference.error` this module otherwise relies on to
 * clear the typing pulse, leaving it stranded until the 120s backstop. */
function hasTurnFailedPart(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const parts = (data as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).turnFailed === true,
  );
}

/**
 * The streaming reply's whole state machine, pure and turn-phase aware
 * (CL-6432 reopened). `message.run.started` — the harness's per-dequeued-
 * message turn begin, the same event the chat orchestrator keys new turns
 * off (see `chat-orchestrator.ts`'s use of `messageRunStarted`) — opens a
 * fresh awaiting turn. While awaiting, `inference.start`/`reactor.start`
 * open the empty pulse (never wiping streamed tokens), each
 * `inference.text.delta` replaces the text with its cumulative snapshot,
 * and a textless `inference.done` keeps the pulse up across pre-reply tool
 * rounds. `connector.reply` — the event the orchestrator posts the
 * persisted reply off — moves the turn to `"replied"`: a live folded run
 * PARKS here (no `message.run.ended`), and its post-reply tool-only rounds
 * (memory writes) still emit `inference.start`/`inference.done`, so in
 * `"replied"` every inference/reactor event is inert rather than
 * re-opening the pulse. The hard-terminal events —
 * `reactor.done`/`reactor.error`, `message.run.ended`, `inference.error`,
 * and a `chat.message` carrying `postUndeliveredNotice`'s `turnFailed`
 * part (see `hasTurnFailedPart`, the one failure path with no `chat.agent`
 * events of its own) — return to idle from any phase. Every other event
 * type (tool calls, thinking, usage) leaves the current state untouched.
 */
export function nextStreamingReplyState(
  current: StreamingReplyState,
  event: { readonly eventType: string; readonly data: unknown },
): StreamingReplyState {
  if (event.eventType === "chat.message") {
    return hasTurnFailedPart(event.data) ? null : current;
  }
  if (event.eventType !== "chat.agent") return current;

  const innerType = innerEventType(event.data);
  if (innerType === "message.run.started") return awaiting("");
  if (
    innerType === "reactor.done" ||
    innerType === "reactor.error" ||
    innerType === "message.run.ended" ||
    innerType === "inference.error"
  ) {
    return null;
  }
  if (innerType === "connector.reply") return REPLIED;
  if (current !== null && current.phase === "replied") return current;

  if (innerType === "inference.start") return current ?? awaiting("");
  // `reactor.start` is the earliest "the agent is on it" signal — it
  // fires before any tokens, often seconds before a slow model's
  // `inference.start` — so it opens the indicator without waiting for
  // the first inference call.
  if (innerType === "reactor.start") return current ?? awaiting("");
  if (innerType === "inference.done") {
    if (current === null || current.text === "") return current;
    return null;
  }

  const delta = parseInferenceDeltaEvent(event.data);
  if (delta === null) return current;
  return awaiting(delta.data.partial.text);
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
  // A `"replied"` previous turn is over — the send that called this opens
  // the next one, so the pulse comes back.
  if (current === null || current.phase === "replied") return awaiting("");
  return current;
}

/**
 * The catch-up snapshot a client reattaching mid-turn (a fresh mount after
 * navigating away and back, CL-6380) hydrates its streaming reply with,
 * before the live SSE tail resumes: a running turn with committed text
 * opens the reply already carrying it; a running turn with none yet (still
 * in its first inference call) opens the same empty pending state
 * `openPendingReply` would; no running turn at all means there's nothing to
 * resume. Never called once a live event has already produced state — see
 * `resumeFromTurn`'s own guard below.
 */
export function hydrateStreamingReplyFromTurn(
  runningTurn: { readonly textSnapshot?: string | null } | null,
): StreamingReplyState {
  if (runningTurn === null) return null;
  return awaiting(runningTurn.textSnapshot ?? "");
}

/** How long a turn may go without a single new token before it's declared
 * dead — the backstop for both a turn whose stream events never arrive at
 * all (agent down, SSE dropped mid-reconnect) and one that starts streaming
 * and then stalls (model OOM, dropped Ollama connection, sidecar crash: all
 * routine with local models, CL-6486). This measures the gap *since the
 * last token*, not total turn duration — a healthy local model can
 * legitimately run 200s+ end to end (round 1 measured ~216s on
 * `qwen3.8:27b`), so a total-elapsed timeout would fire on working replies.
 * 120s of dead air with zero new output, on the other hand, is never a
 * healthy sign even for a slow model — it's long past any single decode
 * step, tool round-trip, or reconnect a client is expected to ride out. */
const PENDING_REPLY_CLEAR_MS = 120_000;

/** Floor on how long the empty typing pulse stays up after it first
 * appears. Fast models can emit `inference.start` + first token in the
 * same tick; without this the bubble flashes and vanishes. */
const TYPING_INDICATOR_MIN_VISIBLE_MS = 700;

export function useStreamingReply(
  workbenchId: string | null,
  clearMs: number = PENDING_REPLY_CLEAR_MS,
  minVisibleMs: number = TYPING_INDICATOR_MIN_VISIBLE_MS,
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
  /** See `resumeFromTurn`'s own doc comment below. */
  readonly resumeFromTurn: (
    runningTurn: { readonly textSnapshot?: string | null } | null,
  ) => void;
} {
  const [streamingReply, setStreamingReply] =
    useState<StreamingReplyState>(null);
  const [replyTimedOut, setReplyTimedOut] = useState(false);
  const pendingSinceRef = useRef<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStreamingReply(null);
    setReplyTimedOut(false);
    pendingSinceRef.current = null;
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [workbenchId]);

  useEffect(() => {
    // Arm for the whole "awaiting" phase, not just its tokenless prefix
    // (CL-6486): a token still growing the reply is not evidence the turn
    // is alive forever, only that it was alive as of that token. Every
    // token produces a new `streamingReply` object (see `awaiting`), so
    // this effect's own dependency below tears down the previous timer and
    // arms a fresh one on each token — the window this constructs is
    // therefore inter-token silence, never total elapsed time.
    if (streamingReply === null || streamingReply.phase !== "awaiting") {
      return;
    }
    const timer = setTimeout(() => {
      // The dependency below re-arms this effect (clearing this exact
      // timer) the instant `streamingReply` changes, so this callback only
      // ever runs while it's still the same pending reply it was armed
      // for — no need to re-check identity here.
      setStreamingReply(null);
      setReplyTimedOut(true);
      pendingSinceRef.current = null;
    }, clearMs);
    return () => clearTimeout(timer);
  }, [streamingReply, clearMs]);

  function commitReply(
    next: StreamingReplyState,
    current: StreamingReplyState,
  ): StreamingReplyState {
    const now = Date.now();
    const becamePending = isPendingReply(next) && !isPendingReply(current);
    if (becamePending) pendingSinceRef.current = now;

    const leavingPending = isPendingReply(current) && !isPendingReply(next);
    if (
      leavingPending &&
      pendingSinceRef.current !== null &&
      now - pendingSinceRef.current < minVisibleMs
    ) {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      const remaining = minVisibleMs - (now - pendingSinceRef.current);
      const held = next;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        pendingSinceRef.current = null;
        setStreamingReply(held);
      }, remaining);
      return current;
    }

    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!isPendingReply(next)) pendingSinceRef.current = null;
    return next;
  }

  function handleStreamEvent(eventType: string, data: unknown) {
    setReplyTimedOut(false);
    setStreamingReply((current) =>
      commitReply(
        nextStreamingReplyState(current, { eventType, data }),
        current,
      ),
    );
  }

  function noteAwaitingReply() {
    setReplyTimedOut(false);
    setStreamingReply((current) =>
      commitReply(openPendingReply(current), current),
    );
  }

  /**
   * Applies a fetched turn-state snapshot (see `api.ts`'s
   * `fetchRunningTurn`) on a fresh mount, before any live event has
   * arrived. Guarded to only ever fill an empty (`null`) state — a stream
   * event that already opened or grew the reply always wins, since it is
   * strictly newer than a snapshot fetched moments earlier over a separate
   * request. A `null` turn (nothing running) is a no-op, not a reset: it
   * must never clear a reply a fast SSE `reactor.start` already opened
   * while the snapshot fetch was in flight.
   */
  function resumeFromTurn(
    runningTurn: { readonly textSnapshot?: string | null } | null,
  ) {
    if (runningTurn === null) return;
    setReplyTimedOut(false);
    setStreamingReply(
      (current) => current ?? hydrateStreamingReplyFromTurn(runningTurn),
    );
  }

  return {
    streamingReply,
    replyTimedOut,
    handleStreamEvent,
    noteAwaitingReply,
    resumeFromTurn,
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
  // Only the tokenless awaiting phase shows the typing line; once text
  // streams, the growing timeline bubble is the signal, and a `"replied"`
  // turn shows nothing at all.
  if (!isPendingReply(streamingReply)) return [];
  const agent = participants.find((participant) =>
    isAgentAddress(participant.address),
  );
  return agent === undefined ? [] : [displayNameFromHandle(agent.handle)];
}
