// The `summarize-older-turns` compactor (CL-6204): a `Compactor` (per
// `@intx/types/runtime`'s `ContextStrategy<ConversationTurn[],
// ConversationTurn[]>`) the sidecar registers on `env.compactors` for
// long-lived channel agents (the assistant workflow's warm, durable-
// conversation step) so a director that names it via
// `caps.compact("summarize-older-turns", reason)` gets a bounded fold
// instead of the reactor growing history until the model window
// truncates it.
//
// Deterministic textual fold, not an LLM call: `ContextStrategy.apply`
// receives only `{ state, trigger }` (`StrategyContext`) -- no inference
// handle -- so an LLM-based summary is not cleanly available inside this
// seam today. A future version could route through a director-supplied
// summarizer if the runtime grows one; until then this fold keeps the
// newest `keep` turns verbatim and replaces everything older with one
// synthetic `system` turn built from bounded, deterministic per-turn
// excerpts.
//
// NB (the remaining CL-6204 gap): nothing calls `caps.compact` yet. The
// built-in `DefaultDirector` (`@intx/inference`'s
// `createDefaultDirector`, the only director our channel-host/assistant
// `AgentDefinition`s reference) never emits a `compact` action -- see
// `resolveDirector` in `@intx/agent/agent.ts`, which surfaces
// `compactorNames` to a director factory but the default factory's
// `decide()` never reads them. Firing compaction for real needs a
// director that decides to compact, which the reactor's control flow
// (`vendor/intx/inference/src/reactor.ts` ~1375) only accepts as an
// action exclusive of `infer` in the same cycle, with no synthetic
// follow-up event afterward -- so a director cannot fire it on
// `message.received` without stalling that message's reply. Registering
// this compactor makes the name resolvable and the fold available; the
// trigger itself needs either a vendor-side chained action/event after
// `executeCompact`, or a definition-side custom director authored via
// `defineDirector`/`createWorkflowDirectorRegistry` that fires compact
// on a cycle that doesn't owe an immediate reply (e.g. `tool.done`
// before the batch's re-infer would still hit the same pairing
// restriction, so even that needs the vendor seam to grow a hook this
// registry alone cannot supply).

import type {
  Compactor,
  ContentBlock,
  ConversationTurn,
  StrategyContext,
  StrategyResult,
} from "@intx/types/runtime";

export const SUMMARIZE_OLDER_TURNS_NAME = "summarize-older-turns";
const SUMMARIZE_OLDER_TURNS_VERSION = "1";

const DEFAULT_KEEP = 12;
const DEFAULT_MAX_SUMMARY_CHARS = 4_000;
const DEFAULT_MAX_EXCERPT_CHARS_PER_TURN = 200;

export type SummarizeOlderTurnsOptions = {
  /** Newest-turn count kept verbatim. Defaults to 12. */
  keep?: number;
  /** Hard cap on the synthetic summary turn's total text length. */
  maxSummaryChars?: number;
  /** Per-folded-turn excerpt cap, applied before the total cap. */
  maxExcerptCharsPerTurn?: number;
};

function roleLabel(role: ConversationTurn["role"]): string {
  return role === "user"
    ? "User"
    : role === "assistant"
      ? "Assistant"
      : "System";
}

/**
 * First line of readable content from a turn's blocks, capped at
 * `maxChars`. Text/refusal blocks contribute their words; every other
 * block kind contributes a short `[<type>]` placeholder so folding
 * never silently drops a turn's shape -- only its detail.
 */
function excerptTurn(turn: ConversationTurn, maxChars: number): string {
  const parts: string[] = [];
  for (const block of turn.content) {
    parts.push(excerptBlock(block));
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

function excerptBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "refusal":
      return block.reason;
    case "tool_call":
      return `[tool_call ${block.name}]`;
    case "tool_result":
      return `[tool_result ${block.callId}]`;
    default:
      return `[${block.type}]`;
  }
}

/**
 * Builds a `summarize-older-turns` `Compactor`. Keeps the newest `keep`
 * turns verbatim; everything older is replaced by one synthetic `system`
 * turn whose text is a numbered, per-turn excerpt list, truncated to
 * `maxSummaryChars` total. Pure and deterministic: the same input always
 * folds to the same output, with no randomness and no external call.
 */
export function createSummarizeOlderTurnsCompactor(
  options: SummarizeOlderTurnsOptions = {},
): Compactor {
  const keep = options.keep ?? DEFAULT_KEEP;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const maxExcerptCharsPerTurn =
    options.maxExcerptCharsPerTurn ?? DEFAULT_MAX_EXCERPT_CHARS_PER_TURN;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(
      `createSummarizeOlderTurnsCompactor: keep must be a non-negative integer, got ${String(keep)}`,
    );
  }

  return {
    name: SUMMARIZE_OLDER_TURNS_NAME,
    version: SUMMARIZE_OLDER_TURNS_VERSION,
    async apply(
      turns: ConversationTurn[],
      _ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      if (turns.length <= keep) {
        return {
          output: turns,
          record: {
            strategy: SUMMARIZE_OLDER_TURNS_NAME,
            version: SUMMARIZE_OLDER_TURNS_VERSION,
            parameters: { keep, maxSummaryChars, maxExcerptCharsPerTurn },
            reason: "within-keep-window",
            decisions: { turnCount: turns.length },
          },
        };
      }

      const splitAt = turns.length - keep;
      const older = turns.slice(0, splitAt);
      const kept = turns.slice(splitAt);

      const lines = older.map(
        (turn, i) =>
          `${String(i + 1)}. ${roleLabel(turn.role)}: ${excerptTurn(turn, maxExcerptCharsPerTurn)}`,
      );
      let summaryText =
        `[Summary of ${String(older.length)} earlier turns, folded to stay ` +
        `within context]\n${lines.join("\n")}`;
      if (summaryText.length > maxSummaryChars) {
        summaryText = `${summaryText.slice(0, maxSummaryChars - 1)}…`;
      }

      const summaryTurn: ConversationTurn = {
        role: "system",
        content: [{ type: "text", text: summaryText }],
        timestamp: older[0]?.timestamp ?? Date.now(),
      };

      return {
        output: [summaryTurn, ...kept],
        record: {
          strategy: SUMMARIZE_OLDER_TURNS_NAME,
          version: SUMMARIZE_OLDER_TURNS_VERSION,
          parameters: { keep, maxSummaryChars, maxExcerptCharsPerTurn },
          reason: "folded-older-turns",
          decisions: {
            foldedCount: older.length,
            keptCount: kept.length,
            summaryChars: summaryText.length,
          },
        },
      };
    },
  };
}
