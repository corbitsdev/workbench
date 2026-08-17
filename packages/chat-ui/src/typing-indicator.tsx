// Presentational typing indicator plus the pure rules that decide whether
// one is showing, and the stateful hook that drives them off the live
// stream. The wire event it renders already exists end-to-end —
// `POST /channels/:id/typing` (packages/chat/src/routes.ts) publishes
// `chat.typing` with `{ principalId }`, and `useChannelStream` already
// forwards that event type (see use-channel-stream.ts) — so this is wiring
// an existing read, not new realtime backend.

import { useEffect, useRef, useState } from "react";

import { Avatar } from "@corbits/react-ui";

import type { ParticipantRecord } from "./api";
import { localPartOf } from "./timeline";
import { CHAT_STRINGS } from "./strings";

/** How long a `chat.typing` ping stays reflected in the banner before it's
 * treated as stale — the sender polls its own composer more often than
 * this, so a live typist never visibly flickers. */
export const TYPING_INDICATOR_TIMEOUT_MS = 4000;

export type TypingEvent = { readonly principalId: string };

/** Parses a `chat.typing` SSE payload at the trust boundary — never trusts
 * the stream's `unknown` data without narrowing it first. */
export function parseTypingEvent(data: unknown): TypingEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const principalId = (data as Record<string, unknown>).principalId;
  return typeof principalId === "string" ? { principalId } : null;
}

export type TypingState = {
  readonly principalId: string;
  readonly expiresAt: number;
} | null;

/**
 * The typing banner's whole state machine, pure: a `chat.typing` event
 * (that isn't the signed-in user's own) sets who is typing and when that
 * fact expires; every other event, or an expired banner, clears it. Kept
 * separate from the `setTimeout` that drives it in `useTypingIndicator` so
 * the rule is testable without mounting anything.
 */
export function nextTypingState(
  current: TypingState,
  event: { readonly eventType: string; readonly data: unknown },
  selfPrincipalId: string | undefined,
  now: number,
  timeoutMs: number,
): TypingState {
  if (event.eventType !== "chat.typing") return current;
  const parsed = parseTypingEvent(event.data);
  if (parsed === null || parsed.principalId === selfPrincipalId) {
    return current;
  }
  return { principalId: parsed.principalId, expiresAt: now + timeoutMs };
}

/**
 * Whether a banner's `expiresAt` has passed. This is the one place that
 * decides "stale" — `useTypingIndicator`'s `setTimeout` fires at exactly
 * `expiresAt`, but only clears the banner if this still says so, so a timer
 * left over from a since-replaced ping can never clobber a fresher one.
 */
export function isTypingStateExpired(state: TypingState, now: number): boolean {
  return state !== null && state.expiresAt <= now;
}

/** A typing principal's friendly handle — falls back to the same
 * deterministic "Member" label the timeline uses, never a raw address. */
export function typingLabel(
  principalId: string,
  participants: readonly ParticipantRecord[],
): string {
  const match = participants.find(
    (participant) => localPartOf(participant.address) === principalId,
  );
  return match?.handle ?? CHAT_STRINGS.senderFallbackMember;
}

/**
 * Owns the typing banner's state end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all) and it tracks the latest
 * `chat.typing` ping, expiring it on its own timer. `channelId` resets the
 * banner immediately on a channel switch — a ping from the channel just
 * left means nothing here, and its principal id may not even resolve to
 * the same participant in the new one.
 */
export function useTypingIndicator(
  selfPrincipalId: string | undefined,
  channelId: string | null,
  timeoutMs: number = TYPING_INDICATOR_TIMEOUT_MS,
): {
  readonly typingState: TypingState;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [typingState, setTypingState] = useState<TypingState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function clearTimer() {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }

  // Cleanup runs both on unmount and right before this effect re-fires for
  // a new channelId, so one effect covers the channel-switch reset and the
  // unmount guard against a stray setState.
  useEffect(() => {
    setTypingState(null);
    return clearTimer;
  }, [channelId]);

  function handleStreamEvent(eventType: string, data: unknown) {
    const now = Date.now();
    const next = nextTypingState(
      typingState,
      { eventType, data },
      selfPrincipalId,
      now,
      timeoutMs,
    );
    if (next === typingState) return;

    setTypingState(next);
    clearTimer();
    if (next !== null) {
      const expiresAt = next.expiresAt;
      timerRef.current = setTimeout(() => {
        setTypingState((current) =>
          isTypingStateExpired(current, Date.now()) ? null : current,
        );
      }, expiresAt - now);
    }
  }

  return { typingState, handleStreamEvent };
}

export function TypingIndicator({ label }: { readonly label: string }) {
  return (
    <div className="chat-typing-indicator" role="status">
      <span className="chat-typing-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{CHAT_STRINGS.typingIndicator(label)}</span>
    </div>
  );
}

/**
 * The names line above the composer: "Myra is typing…", "Myra and Scribe
 * are typing…", "Myra, Scribe and 2 others are typing…" — `names`' order
 * decides who's named before the "and N others" collapse kicks in at three.
 * Renders nothing for an empty list so callers can pass it unconditionally.
 */
export function AgentTypingIndicator({
  names,
}: {
  readonly names: readonly string[];
}) {
  if (names.length === 0) return null;
  return (
    <div className="chat-typing-indicator chat-agent-typing-indicator" role="status">
      <span className="chat-agent-typing-avatars">
        {names.map((name) => (
          <span key={name} className="chat-agent-typing-avatar" title={name}>
            <Avatar initials={name} label={name} tone="agent" size="sm" />
          </span>
        ))}
      </span>
      <span className="chat-typing-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{CHAT_STRINGS.agentsTyping(names)}</span>
    </div>
  );
}
