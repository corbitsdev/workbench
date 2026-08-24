// Presentational typing indicator plus the pure rules that decide whether
// one is showing, and the stateful hook that drives them off the live
// stream. The wire event it renders already exists end-to-end —
// `POST /workbenches/:id/typing` (packages/chat/src/routes.ts) publishes
// `chat.typing` with `{ principalId }`, and `useWorkbenchStream` already
// forwards that event type (see use-workbench-stream.ts) — so this is wiring
// an existing read, not new realtime backend.

import { useEffect, useRef, useState } from "react";

import type { ParticipantRecord } from "./api";
import { localPartOf, type CurrentUser } from "./timeline";
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

/** A typing/presence principal's friendly label — prefers the signed-in
 * reader's own `currentUser.name` when the principal is self (CL-6655),
 * else the participant handle, else the same deterministic "Member"
 * fallback the timeline uses. Never a raw address. */
export function typingLabel(
  principalId: string,
  participants: readonly ParticipantRecord[],
  currentUser?: CurrentUser,
): string {
  if (
    currentUser !== undefined &&
    currentUser.principalId === principalId &&
    currentUser.name !== undefined &&
    currentUser.name.trim().length > 0
  ) {
    return currentUser.name.trim();
  }
  const match = participants.find(
    (participant) => localPartOf(participant.address) === principalId,
  );
  return match?.handle ?? CHAT_STRINGS.senderFallbackMember;
}

/**
 * Owns the typing banner's state end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all) and it tracks the latest
 * `chat.typing` ping, expiring it on its own timer. `workbenchId` resets the
 * banner immediately on a workbench switch — a ping from the workbench just
 * left means nothing here, and its principal id may not even resolve to
 * the same participant in the new one.
 */
export function useTypingIndicator(
  selfPrincipalId: string | undefined,
  workbenchId: string | null,
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
  // a new workbenchId, so one effect covers the workbench-switch reset and the
  // unmount guard against a stray setState.
  useEffect(() => {
    setTypingState(null);
    return clearTimer;
  }, [workbenchId]);

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

/** Quiet three-dot bubble in the incoming-message slot — same left
 * indent as the next agent reply. Who-is-typing copy is visually hidden
 * so the pulse stays iMessage-subtle without dropping the live-region
 * announcement. */
function TypingDotsBubble({ status }: { readonly status: string }) {
  return (
    <div className="chat-bubble-row chat-typing-row" data-own="false">
      <div className="chat-typing-indicator" role="status">
        <span className="chat-typing-indicator-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="chat-typing-indicator-label">{status}</span>
      </div>
    </div>
  );
}

export function TypingIndicator({ label }: { readonly label: string }) {
  return <TypingDotsBubble status={CHAT_STRINGS.typingIndicator(label)} />;
}

/**
 * Pulse in the incoming-message slot while in-flight agent streams are open.
 * `names`' order decides who's named before the "and N others" collapse
 * kicks in at three. Renders nothing for an empty list so callers can
 * pass it unconditionally.
 */
export function AgentTypingIndicator({
  names,
}: {
  readonly names: readonly string[];
}) {
  if (names.length === 0) return null;
  return <TypingDotsBubble status={CHAT_STRINGS.agentsTyping(names)} />;
}
