import type { Transport } from "@intx/hub-client";
import { deriveAgentPhase, type AgentPhase } from "./agent-phase";

/**
 * Tracks an agent's coarse activity phase (idle / thinking / typing) from its
 * raw event stream, for surfaces that need the phase but not the transcript
 * (the sidebar).
 *
 * It is the single-subscription counterpart to the chat's separate live-text
 * and reasoning trackers: one subscription drives all three inputs to
 * deriveAgentPhase — streamed answer text, reasoning text, and an `active`
 * flag. The active flag (set on `inference.start`) is what makes a tool-running
 * turn read as "thinking" rather than "idle" when neither text nor reasoning is
 * streaming yet.
 *
 * Crucially it recovers: a turn that ends without committing — error, abort,
 * dropped sidecar — would otherwise leave the last reasoning text in place and
 * pulse "thinking" forever. Termination events reset all state to idle.
 *
 * A content-less inference pass (a reactor decision cycle that ends in
 * "wait" rather than a reply) never fires any of those termination events —
 * the server has nothing to commit or abort. Left alone, `active` would
 * latch true and the row would read "thinking" indefinitely (CL-3871). Such
 * a pass still always emits `inference.done` with an empty `turn.content`,
 * so that specific event is treated as an extra, narrower reset: it clears
 * `active` only when the pass produced no text/reasoning/tool content,
 * leaving a genuinely productive `inference.done` (content present) alone.
 */
export interface AgentPhaseTracker {
  readonly phase: AgentPhase;
  stop: () => void;
}

const RESET_EVENTS = new Set([
  "turn.committed",
  "reactor.abort",
  "reactor.error",
  "inference.error",
]);

function eventType(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type } = raw as { type?: unknown };
  return typeof type === "string" ? type : null;
}

function partialField(raw: unknown, field: "text" | "thinking"): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { data } = raw as { data?: unknown };
  if (typeof data !== "object" || data === null) return null;
  const { partial } = data as { partial?: unknown };
  if (typeof partial !== "object" || partial === null) return null;
  const value = (partial as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function isContentlessInferenceDone(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const { data } = raw as { data?: unknown };
  if (typeof data !== "object" || data === null) return false;
  const { turn } = data as { turn?: unknown };
  if (typeof turn !== "object" || turn === null) return false;
  const { content } = turn as { content?: unknown };
  return Array.isArray(content) && content.length === 0;
}

export function createAgentPhaseTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): AgentPhaseTracker {
  let streamingText = "";
  let reasoningText = "";
  let active = false;
  let phase: AgentPhase = "idle";

  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  function recompute() {
    const next = deriveAgentPhase({
      activity: active ? { type: "inferring" } : null,
      streamingText,
      reasoningText,
    });
    if (next === phase) return;
    phase = next;
    onUpdate?.();
  }

  const stop = transport.subscribe(
    path,
    (raw) => {
      const type = eventType(raw);
      if (type === null) return;

      if (RESET_EVENTS.has(type)) {
        streamingText = "";
        reasoningText = "";
        active = false;
        recompute();
        return;
      }

      if (type === "inference.start") {
        active = true;
        recompute();
        return;
      }

      if (type === "inference.done") {
        if (isContentlessInferenceDone(raw)) {
          active = false;
          recompute();
        }
        return;
      }

      if (type === "inference.text.delta") {
        const text = partialField(raw, "text");
        if (text !== null) {
          streamingText = text;
          active = true;
          recompute();
        }
        return;
      }

      if (type === "inference.thinking.delta") {
        const thinking = partialField(raw, "thinking");
        if (thinking !== null) {
          reasoningText = thinking;
          active = true;
          recompute();
        }
      }
    },
    { eventName: "agent.event" },
  );

  return {
    get phase() {
      return phase;
    },
    stop,
  };
}
