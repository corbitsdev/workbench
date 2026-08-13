// Presentational typing indicator plus the pure rules that decide whether
// one is showing. The wire event it renders already exists end-to-end —
// `POST /channels/:id/typing` (packages/chat/src/routes.ts) publishes
// `chat.typing` with `{ principalId }`, and `useChannelStream` already
// forwards that event type (see use-channel-stream.ts) — so this is wiring
// an existing read, not new realtime backend.

import type { ParticipantRecord } from "./api";
import { localPartOf } from "./timeline";
import { CHAT_STRINGS } from "./strings";

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
 * separate from the `setTimeout` that drives it in `chat-workspace.tsx` so
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
