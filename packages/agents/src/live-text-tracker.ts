import type { Transport } from '@intx/hub-client';

/**
 * Tracks the live text of the turn the agent is currently streaming.
 *
 * The interchange session exposes a `streaming` buffer, but it accumulates
 * across turns: when a turn commits with empty text (CL-1398) the session can
 * never match the committed text to clear the buffer, so the next turn's deltas
 * append to it and it ends up holding `[committed reply 1][committed reply 2]…`.
 * Folding that buffer onto the trailing bubble merges separate replies into one
 * until a hard reload (CL-1643).
 *
 * The raw stream carries the truth: every `inference.text.delta` event includes
 * a `partial.text` snapshot that is cumulative *within the current turn only* —
 * it resets to that turn's first tokens when a new turn starts. So we mirror the
 * tool-name tracker: subscribe to the same event stream, mirror `partial.text`
 * as the live text, and clear it on `turn.committed` (the text is now durable,
 * rendered from the committed turn or mail). `inference.text.replay` seeds the
 * text for a subscriber that joined mid-turn.
 */
export interface LiveTextTracker {
  /** The current turn's live streamed text. Empty when nothing is streaming. */
  readonly text: string;
  /** Tears down the underlying event subscription. */
  stop: () => void;
}

interface TextDeltaEvent {
  type: 'inference.text.delta';
  data: { partial: { text: string } };
}

interface TurnCommittedEvent {
  type: 'turn.committed';
}

interface TextReplayEvent {
  type: 'inference.text.replay';
  data: { text: string };
}

function parseTextDeltaEvent(raw: unknown): TextDeltaEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (type !== 'inference.text.delta') return null;
  if (typeof data !== 'object' || data === null) return null;
  const { partial } = data as { partial?: unknown };
  if (typeof partial !== 'object' || partial === null) return null;
  const { text } = partial as { text?: unknown };
  if (typeof text !== 'string') return null;
  return { type, data: { partial: { text } } };
}

function parseTurnCommittedEvent(raw: unknown): TurnCommittedEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type } = raw as { type?: unknown };
  if (type !== 'turn.committed') return null;
  return { type };
}

function parseTextReplayEvent(raw: unknown): TextReplayEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (type !== 'inference.text.replay') return null;
  if (typeof data !== 'object' || data === null) return null;
  const { text } = data as { text?: unknown };
  if (typeof text !== 'string') return null;
  return { type, data: { text } };
}

export function createLiveTextTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void
): LiveTextTracker {
  let text = '';
  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  const stop = transport.subscribe(
    path,
    (raw) => {
      const delta = parseTextDeltaEvent(raw);
      if (delta !== null) {
        if (text === delta.data.partial.text) return;
        text = delta.data.partial.text;
        onUpdate?.();
        return;
      }

      if (parseTurnCommittedEvent(raw) !== null) {
        if (text === '') return;
        text = '';
        onUpdate?.();
        return;
      }

      const replay = parseTextReplayEvent(raw);
      if (replay !== null && text === '') {
        text = replay.data.text;
        onUpdate?.();
      }
    },
    { eventName: 'agent.event' }
  );

  return {
    get text() {
      return text;
    },
    stop,
  };
}
