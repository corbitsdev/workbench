import type { AgentActivity } from "@intx/hub-client";

/**
 * Coarse, UI-facing activity phase for an agent, derived from the live stream:
 * - `typing`   — the agent is streaming visible answer text
 * - `thinking` — the agent is reasoning or otherwise working (no answer yet)
 * - `idle`     — nothing in flight
 *
 * Answer text wins over reasoning: once visible tokens stream the user should
 * see "typing", even if a `thinking` partial is still attached to the turn.
 */
export type AgentPhase = "idle" | "thinking" | "typing";

export function deriveAgentPhase(input: {
  activity: AgentActivity | null;
  streamingText: string;
  reasoningText: string;
}): AgentPhase {
  if (input.streamingText.length > 0) return "typing";
  if (input.reasoningText.length > 0) return "thinking";
  if (input.activity !== null) return "thinking";
  return "idle";
}
