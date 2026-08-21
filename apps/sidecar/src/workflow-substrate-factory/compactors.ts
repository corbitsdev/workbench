// Two `Compactor`s (per `@intx/types/runtime`'s `ContextStrategy<
// ConversationTurn[], ConversationTurn[]>`), both deterministic textual
// folds, not LLM calls: `ContextStrategy.apply` receives only `{ state,
// trigger }` (`StrategyContext`) -- no inference handle -- so an
// LLM-based summary is not cleanly available inside this seam today.
//
// - `summarize-older-turns`: fixed `keep` (default 12), registered on
//   `env.compactors` for a director that names it via
//   `caps.compact("summarize-older-turns", reason)`.
// - `summarize-budgeted-turns` (CL-6204): the one actually fired, by
//   `WorkbenchDirector` (see `./workbench-director`) via the same
//   `caps.compact` reactor action. `@intx/agent`'s `createAgent` does
//   not thread a `ContextTransform` seam through `BaseEnv` at all (only
//   `env.compactors` reaches `createReactorAssembly` -- confirmed
//   against `@intx/agent`'s `agent.js`), so the reactor's `compact`
//   action is the only seam actually available; `WorkbenchDirector`
//   fires it only at the one point in the reactor's event flow where
//   `compact`'s exclusion from `infer` in the same cycle cannot stall a
//   reply -- see that file's header comment for exactly which point and
//   why.
//
// Both folds are deliberately lossy -- a bounded recap of what was
// active in the folded turns, not a durable record. Anything a channel
// agent needs to recall past the working window is firm memory's job
// (`@corbits/memory-tools`'s `memory_search`/`memory_add`, already
// pinned for the assistant workflow), not this recap's.

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

export const SUMMARIZE_BUDGETED_TURNS_NAME = "summarize-budgeted-turns";
const SUMMARIZE_BUDGETED_TURNS_VERSION = "1";
const MIN_KEPT_TURNS = 4;

function turnChars(turn: ConversationTurn): number {
  let total = 0;
  for (const block of turn.content) {
    total += blockPayloadChars(block);
  }
  return total;
}

/**
 * A media block's real payload size: base64 data / a URL / a file
 * reference, whichever the source carries. Shared by top-level media
 * blocks and the media items nested in a `tool_result`'s `content`.
 */
function mediaSourceChars(source: {
  kind: "base64" | "file-reference" | "url";
  data?: string;
  url?: string;
  reference?: string;
}): number {
  switch (source.kind) {
    case "base64":
      return source.data?.length ?? 0;
    case "url":
      return source.url?.length ?? 0;
    case "file-reference":
      return source.reference?.length ?? 0;
  }
}

/**
 * A `tool_result` content item's real size: text length, or the
 * underlying media source's size for every other item kind.
 */
function toolResultItemChars(
  item: Extract<ContentBlock, { type: "tool_result" }>["content"][number],
): number {
  return item.type === "text"
    ? item.text.length
    : mediaSourceChars(item.source);
}

/**
 * A block's true payload size -- what actually ships to the model --
 * as distinct from {@link excerptBlock}'s human-readable placeholder.
 * `tool_call.arguments` and `tool_result.content` carry real request/
 * response payloads that can dwarf the rest of a turn; a budget
 * estimator blind to them silently undercounts by orders of magnitude.
 */
function blockPayloadChars(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "refusal":
      return block.reason.length;
    case "thinking":
      return block.thinking.length;
    case "redacted_thinking":
      return block.data.length;
    case "citation":
      return block.citedText.length;
    case "safety_rating":
      return block.blockReason.length;
    case "code_execution_request":
      return block.code.length;
    case "code_execution_result":
      return (block.stdout?.length ?? 0) + (block.stderr?.length ?? 0);
    case "image":
    case "audio":
    case "video":
    case "document":
      return mediaSourceChars(block.source);
    case "tool_call":
      return block.name.length + JSON.stringify(block.arguments).length;
    case "tool_result": {
      let total = 0;
      for (const item of block.content) {
        total += toolResultItemChars(item);
      }
      if (block.detail !== undefined) {
        total += JSON.stringify(block.detail).length;
      }
      return total;
    }
    default:
      return 0;
  }
}

/** Total character length of a turn list -- the budget check's estimate. */
export function estimateTurnsChars(turns: ConversationTurn[]): number {
  let total = 0;
  for (const turn of turns) {
    total += turnChars(turn);
  }
  return total;
}

/**
 * Newest-first walk that keeps turns while their combined length stays
 * under `budgetChars`, with a floor of `MIN_KEPT_TURNS` so the most
 * recent exchange is never folded away even when it alone exceeds
 * budget (the honest-overflow case a director checks separately).
 */
function countTurnsWithinBudget(
  turns: ConversationTurn[],
  budgetChars: number,
): number {
  let runningChars = 0;
  let kept = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const chars = turnChars(turn);
    if (kept >= MIN_KEPT_TURNS && runningChars + chars > budgetChars) {
      break;
    }
    runningChars += chars;
    kept += 1;
  }
  return kept;
}

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

      return foldOlderTurns(turns, keep, {
        strategy: SUMMARIZE_OLDER_TURNS_NAME,
        version: SUMMARIZE_OLDER_TURNS_VERSION,
        maxSummaryChars,
        maxExcerptCharsPerTurn,
      });
    },
  };
}

/**
 * Shared fold: keeps the newest `keep` turns verbatim and replaces
 * everything older with one synthetic `system` turn of numbered,
 * per-turn excerpts, truncated to `maxSummaryChars`. The recap is
 * deliberately lossy -- it is a bounded reminder of what was active in
 * the folded turns, not a durable record. Anything a channel agent
 * needs to recall past the working window belongs in firm memory
 * (`@corbits/memory-tools`'s `memory_search`/`memory_add`), not in this
 * recap.
 */
function foldOlderTurns(
  turns: ConversationTurn[],
  keep: number,
  meta: {
    strategy: string;
    version: string;
    maxSummaryChars: number;
    maxExcerptCharsPerTurn: number;
  },
): StrategyResult<ConversationTurn[]> {
  const splitAt = turns.length - keep;
  const older = turns.slice(0, splitAt);
  const kept = turns.slice(splitAt);

  const lines = older.map(
    (turn, i) =>
      `${String(i + 1)}. ${roleLabel(turn.role)}: ${excerptTurn(turn, meta.maxExcerptCharsPerTurn)}`,
  );
  let summaryText =
    `[Summary of ${String(older.length)} earlier turns, folded to stay ` +
    `within context]\n${lines.join("\n")}`;
  if (summaryText.length > meta.maxSummaryChars) {
    summaryText = `${summaryText.slice(0, meta.maxSummaryChars - 1)}…`;
  }

  const summaryTurn: ConversationTurn = {
    role: "system",
    content: [{ type: "text", text: summaryText }],
    timestamp: older[0]?.timestamp ?? Date.now(),
  };

  return {
    output: [summaryTurn, ...kept],
    record: {
      strategy: meta.strategy,
      version: meta.version,
      parameters: {
        keep,
        maxSummaryChars: meta.maxSummaryChars,
        maxExcerptCharsPerTurn: meta.maxExcerptCharsPerTurn,
      },
      reason: "folded-older-turns",
      decisions: {
        foldedCount: older.length,
        keptCount: kept.length,
        summaryChars: summaryText.length,
      },
    },
  };
}

export type BudgetedContextCompactorOptions = {
  /** Hard cap on the synthetic summary turn's total text length. */
  maxSummaryChars?: number;
  /** Per-folded-turn excerpt cap, applied before the total cap. */
  maxExcerptCharsPerTurn?: number;
};

/**
 * Builds a `summarize-budgeted-turns` `Compactor`: folds turns older
 * than the newest ones that fit `budgetChars` (with a floor of
 * `MIN_KEPT_TURNS` verbatim), instead of a fixed turn count.
 * `budgetChars` should come from `resolveContextBudgetChars` so the
 * fold point tracks the model's actual context window rather than one
 * constant shared by every model.
 *
 * Registered on `env.compactors` (see `./step-env`) and fired by
 * `WorkbenchDirector` via `caps.compact("summarize-budgeted-turns", …)`
 * only at the one point in the reactor's event flow where doing so
 * cannot stall a reply -- see `./workbench-director`'s header comment.
 */
export function createBudgetedContextCompactor(
  budgetChars: number,
  options: BudgetedContextCompactorOptions = {},
): Compactor {
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const maxExcerptCharsPerTurn =
    options.maxExcerptCharsPerTurn ?? DEFAULT_MAX_EXCERPT_CHARS_PER_TURN;

  return {
    name: SUMMARIZE_BUDGETED_TURNS_NAME,
    version: SUMMARIZE_BUDGETED_TURNS_VERSION,
    async apply(
      turns: ConversationTurn[],
      _ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      // First check against the full budget, exactly as when no fold is
      // needed at all -- a conversation already under budget must stay
      // untouched rather than being folded pre-emptively to make room
      // for a summary turn nothing will produce.
      if (countTurnsWithinBudget(turns, budgetChars) >= turns.length) {
        return {
          output: turns,
          record: {
            strategy: SUMMARIZE_BUDGETED_TURNS_NAME,
            version: SUMMARIZE_BUDGETED_TURNS_VERSION,
            parameters: {
              budgetChars,
              maxSummaryChars,
              maxExcerptCharsPerTurn,
            },
            reason: "within-budget",
            decisions: { turnCount: turns.length },
          },
        };
      }

      // Folding does happen: reserve the summary turn's own worst-case
      // size out of the budget so kept-turns chars + summary chars
      // together stay within `budgetChars`, instead of the summary
      // landing on top of an already-full budget.
      const keepBudgetChars = Math.max(0, budgetChars - maxSummaryChars);
      const keep = countTurnsWithinBudget(turns, keepBudgetChars);
      return foldOlderTurns(turns, keep, {
        strategy: SUMMARIZE_BUDGETED_TURNS_NAME,
        version: SUMMARIZE_BUDGETED_TURNS_VERSION,
        maxSummaryChars,
        maxExcerptCharsPerTurn,
      });
    },
  };
}
