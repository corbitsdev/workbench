import type { ConversationTurn } from "@intx/types/runtime";

/**
 * True for an assistant turn that the OpenAI-compatible adapter would marshal
 * to `{ role: "assistant", content: null }` with no `tool_calls`. The adapter
 * only reads `text`, `thinking`, and `tool_call` blocks when building an
 * assistant message, so a turn carrying neither text nor a tool call (a
 * reasoning-only turn left behind by an aborted generation, or one holding
 * only `thinking` / `redacted_thinking` / `image` blocks) collapses to a null
 * body. DeepSeek and similar providers reject that — "Invalid assistant
 * message: content or tool_calls must be set" — and once such a turn is
 * committed to the durable context store it poisons every subsequent
 * inference, since the agent replays it on each launch.
 *
 * Scope: this targets the null-body 400 only. Turns carrying `refusal` or
 * `code_execution_*` blocks are a separate, adapter-throw failure mode and are
 * intentionally not handled here — silently dropping that semantic content
 * would corrupt the conversation, so the adapter is left to surface it.
 */
function isUnsendableAssistantTurn(turn: ConversationTurn): boolean {
  if (turn.role !== "assistant") return false;
  return !turn.content.some(
    (block) => block.type === "text" || block.type === "tool_call",
  );
}

export interface ContextRepairResult {
  turns: ConversationTurn[];
  removedCount: number;
}

/**
 * Drop assistant turns that cannot be sent to an OpenAI-compatible provider.
 * Returns the original array reference untouched when there is nothing to
 * remove, so callers can cheaply skip the commit in the common case.
 */
export function stripUnsendableAssistantTurns(
  turns: ConversationTurn[],
): ContextRepairResult {
  const kept = turns.filter((turn) => !isUnsendableAssistantTurn(turn));
  if (kept.length === turns.length) {
    return { turns, removedCount: 0 };
  }
  return { turns: kept, removedCount: turns.length - kept.length };
}
