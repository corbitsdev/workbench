import type { Transport } from "@intx/hub-client";

/**
 * Tracks the live reasoning ("thinking") text of the turn the agent is
 * currently streaming.
 *
 * Mirrors createLiveTextTracker: the interchange session derives an `activity`
 * but never captures the reasoning content. The raw stream carries it —
 * `inference.thinking.delta` events include a `partial.thinking` snapshot that
 * is cumulative *within the current turn only*. We subscribe to the same event
 * stream, mirror `partial.thinking` as the live reasoning, and clear it on
 * `turn.committed` (the turn is durable; its reasoning is no longer "live").
 *
 * Using the cumulative `partial.thinking` snapshot (not the incremental
 * `token`) makes the tracker idempotent: the same delta delivered twice — three
 * independent SSE connections hit the same endpoint — does not double-count.
 */
export interface ReasoningTracker {
  /** The current turn's live reasoning text. Empty when nothing is thinking. */
  readonly text: string;
  /** Tears down the underlying event subscription. */
  stop: () => void;
}

interface ThinkingDeltaEvent {
  type: "inference.thinking.delta";
  data: { partial: { thinking: string } };
}

// Events that end the current turn. `turn.committed` is the normal path; the
// reactor/inference errors are the failure paths that would otherwise leave the
// last reasoning text in place and render a stale "thinking" bubble forever
// (CL-1660 review).
const TURN_END_EVENTS = new Set([
  "turn.committed",
  "reactor.abort",
  "reactor.error",
  "inference.error",
]);

function parseThinkingDeltaEvent(raw: unknown): ThinkingDeltaEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (type !== "inference.thinking.delta") return null;
  if (typeof data !== "object" || data === null) return null;
  const { partial } = data as { partial?: unknown };
  if (typeof partial !== "object" || partial === null) return null;
  const { thinking } = partial as { thinking?: unknown };
  if (typeof thinking !== "string") return null;
  return { type, data: { partial: { thinking } } };
}

function isTurnEndEvent(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const { type } = raw as { type?: unknown };
  return typeof type === "string" && TURN_END_EVENTS.has(type);
}

export function createReasoningTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): ReasoningTracker {
  let text = "";
  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  const stop = transport.subscribe(
    path,
    (raw) => {
      const delta = parseThinkingDeltaEvent(raw);
      if (delta !== null) {
        if (text === delta.data.partial.thinking) return;
        text = delta.data.partial.thinking;
        onUpdate?.();
        return;
      }

      if (isTurnEndEvent(raw)) {
        if (text === "") return;
        text = "";
        onUpdate?.();
      }
    },
    { eventName: "agent.event" },
  );

  return {
    get text() {
      return text;
    },
    stop,
  };
}
