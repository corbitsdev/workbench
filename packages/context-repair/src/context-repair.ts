import { type } from "arktype";
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

// turns: "unknown[]" -- ConversationTurn is a recursive discriminated union from
// @intx/types/runtime (interchange, out of scope for arktype's string DSL). The
// exported type intersection below restores the correct static type; element-level
// validation of turns is intentionally skipped.
const ContextRepairResult = type({ turns: "unknown[]", removedCount: "number" });
export type ContextRepairResult = Omit<typeof ContextRepairResult.infer, "turns"> & {
  turns: ConversationTurn[];
};

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

type ContentBlock = ConversationTurn["content"][number];
type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;

/**
 * Body of the placeholder result we synthesize for an interrupted tool call.
 * Deliberately neutral and actionable: the model should see that the call was
 * attempted and that no result came back, rather than the call silently
 * vanishing from history.
 */
const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool call interrupted — the session ended before a result was recorded. No result is available; retry the call or continue without it.";

function isToolCall(block: ContentBlock): block is ToolCallBlock {
  return block.type === "tool_call";
}

function synthesizeResultTurn(
  calls: ToolCallBlock[],
  timestamp: number,
): ConversationTurn {
  return {
    role: "user",
    timestamp,
    content: calls.map((call) => ({
      type: "tool_result" as const,
      callId: call.id,
      content: [{ type: "text" as const, text: INTERRUPTED_TOOL_RESULT_TEXT }],
      isError: true,
    })),
  };
}

// turns: "unknown[]" -- same ConversationTurn constraint as ContextRepairResult above.
const ToolPairingRepairResult = type({
  turns: "unknown[]",
  // tool_results synthesized for assistant tool_calls that had none.
  synthesizedResults: "number",
  // dangling tool_result blocks dropped (no matching tool_call).
  droppedResults: "number",
});
export type ToolPairingRepairResult = Omit<
  typeof ToolPairingRepairResult.infer,
  "turns"
> & { turns: ConversationTurn[] };

/**
 * Enforce the tool_call/tool_result pairing invariant OpenAI-compatible
 * providers require: every assistant `tool_call` must be answered by a
 * following `tool_result`, and every `tool_result` must answer a `tool_call`
 * that exists. Violations are the orphaned-tool_call 400 ("'tool_calls' must
 * be followed by tool messages") and its mirror.
 *
 * Root cause is upstream: the reactor persists the assistant tool_call turn
 * durably but holds the tool_result in memory until the next commit, so a
 * teardown in that window strands the call. We cannot reorder that write, so
 * we repair the durable context at launch. Orphaned calls get a synthesized
 * error result (preserving the fact the call happened); dangling results are
 * dropped (their call is gone, so nothing can legitimately answer them).
 * Returns the original array reference when pairing is already sound.
 */
export function repairToolCallPairing(
  turns: ConversationTurn[],
): ToolPairingRepairResult {
  const answeredCallIds = new Set<string>();
  const presentCallIds = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_result") answeredCallIds.add(block.callId);
      else if (block.type === "tool_call") presentCallIds.add(block.id);
    }
  }

  const repaired: ConversationTurn[] = [];
  let synthesizedResults = 0;
  let droppedResults = 0;

  for (const turn of turns) {
    const dangling = turn.content.filter(
      (block) =>
        block.type === "tool_result" && !presentCallIds.has(block.callId),
    );

    let content = turn.content;
    if (dangling.length > 0) {
      droppedResults += dangling.length;
      content = turn.content.filter((block) => !dangling.includes(block));
      // A turn emptied by dropping its only (dangling) results carries nothing
      // sendable, so drop it entirely.
      if (content.length === 0) continue;
    }

    const cleaned = content === turn.content ? turn : { ...turn, content };
    repaired.push(cleaned);

    // Synthesize for unanswered calls even on a turn we just cleaned of a
    // dangling result — the two repairs are independent and must both apply.
    if (cleaned.role !== "assistant") continue;
    const unanswered = content
      .filter(isToolCall)
      .filter((call) => !answeredCallIds.has(call.id));
    if (unanswered.length > 0) {
      repaired.push(synthesizeResultTurn(unanswered, turn.timestamp));
      synthesizedResults += unanswered.length;
    }
  }

  if (synthesizedResults === 0 && droppedResults === 0) {
    return { turns, synthesizedResults: 0, droppedResults: 0 };
  }
  return { turns: repaired, synthesizedResults, droppedResults };
}

// turns: "unknown[]" -- same ConversationTurn constraint as above.
const ContextHealResult = type({
  turns: "unknown[]",
  changed: "boolean",
  unsendableRemoved: "number",
  toolResultsSynthesized: "number",
  danglingResultsDropped: "number",
});
export type ContextHealResult = Omit<typeof ContextHealResult.infer, "turns"> & {
  turns: ConversationTurn[];
};

/**
 * Full launch-time heal of a durable transcript: strip null-body assistant
 * turns, then enforce tool_call/tool_result pairing. Order matters — stripping
 * an assistant turn can strand its tool_result, which the pairing pass then
 * drops. Returns the original array reference when nothing changed.
 */
export function healTurns(turns: ConversationTurn[]): ContextHealResult {
  const stripped = stripUnsendableAssistantTurns(turns);
  const repaired = repairToolCallPairing(stripped.turns);
  const changed =
    stripped.removedCount > 0 ||
    repaired.synthesizedResults > 0 ||
    repaired.droppedResults > 0;
  return {
    turns: changed ? repaired.turns : turns,
    changed,
    unsendableRemoved: stripped.removedCount,
    toolResultsSynthesized: repaired.synthesizedResults,
    danglingResultsDropped: repaired.droppedResults,
  };
}
