import { runInference, type Dependencies } from "@workbench/inference";
import type {
  Compactor,
  ConversationTurn,
  ContentBlock,
  InferenceSource,
  StrategyContext,
  StrategyResult,
} from "@intx/types/runtime";
import { SUMMARY_AGENT_DEPLOY_DESCRIPTOR } from "./summary-agent/definition";
import { buildSummaryAgentSystemPrompt } from "./summary-agent/prompt";

export const SUMMARIZE_COMPACTOR_NAME = "summarize";
export const SUMMARIZE_COMPACTOR_VERSION = "1";

// Retained verbatim from the tail of the input so the summary compaction
// does not lose thread on the exchange in progress.
export const RETAIN_RECENT_EXCHANGES = 2;

// Bounds the compaction call's own output so it cannot itself blow the
// context window it is trying to shrink.
const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

const summaryDefaultModel =
  SUMMARY_AGENT_DEPLOY_DESCRIPTOR.modelConfig?.defaultModel;

if (summaryDefaultModel === undefined) {
  throw new Error(
    "summarize compactor: SUMMARY_AGENT_DEPLOY_DESCRIPTOR has no default model configured",
  );
}

// The summary agent's configured model. The compactor itself never picks a
// model — the caller (the sidecar harness) is responsible for handing in a
// source that actually serves it, or falling back to a source that can serve
// something else.
export const SUMMARY_MODEL_ID: string = summaryDefaultModel;

/**
 * Provider known to serve `SUMMARY_MODEL_ID` (OpenCode Zen / openai-compatible
 * gateway). Selection is explicit about this pair — never "first
 * openai-compatible source" without pinning the summary model, and never a
 * different provider's openai-compatible-shaped source that may 400 on
 * `deepseek-v4-flash`.
 */
export const SUMMARY_MODEL_PROVIDER = "openai-compatible" as const;

export type CompactorSourceResolution = {
  source: InferenceSource;
  /** True when summarizing on SUMMARY_MODEL_ID via SUMMARY_MODEL_PROVIDER. */
  usesCheapSummaryModel: boolean;
  reason: "cheap-summary-provider" | "agent-default-fallback";
};

/**
 * Pick the inference source the summarize compactor should run on.
 *
 * Prefer a source whose `provider` is exactly `SUMMARY_MODEL_PROVIDER` and pin
 * its model to `SUMMARY_MODEL_ID`. If none is available (Anthropic-only agents
 * today pin only their own provider), fall back to the first source unchanged
 * so compaction still runs — just on the agent's own (full-price) model.
 */
export function resolveCompactorSource(
  sources: readonly InferenceSource[],
): CompactorSourceResolution {
  if (sources.length === 0) {
    throw new Error(
      "resolveCompactorSource: no inference sources available for the summarize compactor",
    );
  }
  const cheap = sources.find((s) => s.provider === SUMMARY_MODEL_PROVIDER);
  if (cheap !== undefined) {
    return {
      source: { ...cheap, model: SUMMARY_MODEL_ID },
      usesCheapSummaryModel: true,
      reason: "cheap-summary-provider",
    };
  }
  const fallback = sources[0];
  if (fallback === undefined) {
    throw new Error(
      "resolveCompactorSource: no inference sources available for the summarize compactor",
    );
  }
  return {
    source: fallback,
    usesCheapSummaryModel: false,
    reason: "agent-default-fallback",
  };
}

export type CreateSummarizeCompactorOpts = {
  // The inference source the compaction call runs on. Used verbatim — the
  // compactor does not rewrite its model. The caller must hand in a source
  // whose provider actually serves whatever model is set on it (e.g.
  // `resolveCompactorSource` selects an openai-compatible source and pins
  // `SUMMARY_MODEL_ID`, or falls back to the agent's own default source when
  // no such source is available).
  source: InferenceSource;
  deps: Dependencies;
};

// Bounds how much text a single rendered content block (or the tool-result
// text nested inside it) contributes to the summarizer's input, so one
// oversized tool payload cannot itself blow the compaction call's own
// context budget.
const MAX_RENDERED_BLOCK_CHARS = 4_000;

function truncate(text: string): string {
  return text.length > MAX_RENDERED_BLOCK_CHARS
    ? `${text.slice(0, MAX_RENDERED_BLOCK_CHARS)}…[truncated]`
    : text;
}

function isExchangeStart(turn: ConversationTurn): boolean {
  return turn.role === "user";
}

// Splits `turns` into exchanges, each starting at a user turn (any leading
// turns before the first user turn form their own leading exchange).
function splitIntoExchanges(turns: ConversationTurn[]): ConversationTurn[][] {
  const exchanges: ConversationTurn[][] = [];
  let current: ConversationTurn[] = [];
  for (const turn of turns) {
    if (isExchangeStart(turn) && current.length > 0) {
      exchanges.push(current);
      current = [];
    }
    current.push(turn);
  }
  if (current.length > 0) exchanges.push(current);
  return exchanges;
}

// Drops a leading orphan `tool_result` block (a result whose `tool_call`
// was left behind in the summarized-away prefix) so the retained tail
// never opens with a stranded result. If dropping the block empties the
// turn's content entirely, the turn itself is dropped.
function dropLeadingOrphanToolResult(
  turns: ConversationTurn[],
): ConversationTurn[] {
  if (turns.length === 0) return turns;
  const [first, ...rest] = turns;
  if (first === undefined) return turns;

  const calledIds = new Set<string>();
  for (const block of first.content) {
    if (block.type === "tool_call") calledIds.add(block.id);
  }

  const filteredContent: ContentBlock[] = first.content.filter((block) => {
    if (block.type !== "tool_result") return true;
    return calledIds.has(block.callId);
  });

  if (filteredContent.length === 0) return rest;
  return [{ ...first, content: filteredContent }, ...rest];
}

// Drops a trailing orphan `tool_call` block (a call whose `tool_result` was
// left behind, either summarized away or simply not yet produced) so the
// retained tail never closes with a dangling call the model would otherwise
// be prompted to resolve against a result it can't see. Symmetric to
// `dropLeadingOrphanToolResult`. If dropping the block empties the turn's
// content entirely, the turn itself is dropped.
function dropTrailingOrphanToolCall(
  turns: ConversationTurn[],
): ConversationTurn[] {
  if (turns.length === 0) return turns;
  const last = turns[turns.length - 1];
  if (last === undefined) return turns;
  const rest = turns.slice(0, -1);

  const resultedIds = new Set<string>();
  for (const block of last.content) {
    if (block.type === "tool_result") resultedIds.add(block.callId);
  }

  const filteredContent: ContentBlock[] = last.content.filter((block) => {
    if (block.type !== "tool_call") return true;
    return resultedIds.has(block.id);
  });

  if (filteredContent.length === 0) return rest;
  return [...rest, { ...last, content: filteredContent }];
}

function retainedTail(turns: ConversationTurn[]): ConversationTurn[] {
  const exchanges = splitIntoExchanges(turns);
  const tailExchanges = exchanges.slice(-RETAIN_RECENT_EXCHANGES);
  const tail = tailExchanges.flat();
  return dropTrailingOrphanToolCall(dropLeadingOrphanToolResult(tail));
}

// Flattens one content block to render-ready text so the summarizer sees the
// facts it must preserve rather than a placeholder. Mirrors the block
// flattening in `apps/hub/src/services/turn-input-snapshot.ts`
// `projectBlocks` — media collapses to a placeholder, tool results render
// their nested content, everything is length-bounded.
function renderBlockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case "text":
      return truncate(block.text);
    case "thinking":
      return truncate(block.thinking);
    case "refusal":
      return truncate(block.reason);
    case "tool_call":
      return truncate(
        `[called tool ${block.name} with ${JSON.stringify(block.arguments)}]`,
      );
    case "tool_result": {
      const nested = block.content
        .map((inner) => renderBlockText(inner))
        .filter((text): text is string => text !== undefined)
        .join("\n");
      return truncate(`[tool result for ${block.callId}] ${nested}`);
    }
    case "citation":
      return truncate(`[citation] ${block.citedText}`);
    case "image":
    case "audio":
    case "video":
    case "document":
      return `[${block.type}]`;
    default:
      return undefined;
  }
}

function renderTurnsAsText(turns: ConversationTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    for (const block of turn.content) {
      const text = renderBlockText(block);
      if (text !== undefined) lines.push(`${turn.role}: ${text}`);
    }
  }
  return lines.join("\n");
}

function unchangedResult(
  turns: ConversationTurn[],
  reason: string,
): StrategyResult<ConversationTurn[]> {
  return {
    output: turns,
    record: {
      strategy: SUMMARIZE_COMPACTOR_NAME,
      version: SUMMARIZE_COMPACTOR_VERSION,
      parameters: { retainRecentExchanges: RETAIN_RECENT_EXCHANGES },
      reason,
      decisions: { kept: turns.length, dropped: 0 },
    },
  };
}

export function createSummarizeCompactor(
  opts: CreateSummarizeCompactorOpts,
): Compactor {
  return {
    name: SUMMARIZE_COMPACTOR_NAME,
    version: SUMMARIZE_COMPACTOR_VERSION,
    async apply(
      turns: ConversationTurn[],
      ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      if (turns.length === 0) {
        return unchangedResult(turns, ctx.trigger);
      }

      const systemTurn: ConversationTurn = {
        role: "system",
        content: [
          { type: "text", text: buildSummaryAgentSystemPrompt({ xml: false }) },
        ],
        timestamp: Date.now(),
      };
      const conversationTurn: ConversationTurn = {
        role: "user",
        content: [{ type: "text", text: renderTurnsAsText(turns) }],
        timestamp: Date.now(),
      };

      let seq = 0;
      let summaryText: string | undefined;
      let summaryUsage:
        | {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            thinking: number;
          }
        | undefined;
      let summarySource:
        | { sourceId: string; provider: string; model: string }
        | undefined;
      try {
        for await (const event of runInference({
          turns: [systemTurn, conversationTurn],
          source: opts.source,
          inferenceOptions: { maxTokens: SUMMARY_MAX_OUTPUT_TOKENS },
          nextSeq: () => seq++,
          deps: opts.deps,
        })) {
          if (event.type === "inference.done") {
            const textBlock = event.data.turn.content.find(
              (block) => block.type === "text",
            );
            if (textBlock !== undefined && textBlock.type === "text") {
              summaryText = textBlock.text;
            }
            summaryUsage = event.data.usage;
            summarySource = event.data.source;
          }
        }
      } catch {
        return unchangedResult(turns, "summarize-inference-failed");
      }

      if (summaryText === undefined || summaryText.trim().length === 0) {
        return unchangedResult(turns, "summarize-inference-empty");
      }

      // A `user` turn, not `assistant`: the compacted working set must start
      // with a user-role message to stay valid on providers (Anthropic,
      // Gemini) that require the first non-system message to be from the
      // user.
      const summaryTurn: ConversationTurn = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Summary of prior conversation:\n${summaryText}`,
          },
        ],
        timestamp: Date.now(),
      };

      const tail = retainedTail(turns);
      const output = [summaryTurn, ...tail];
      const summaryChars = summaryTurn.content[0]?.type === "text"
        ? summaryTurn.content[0].text.length
        : 0;

      return {
        output,
        record: {
          strategy: SUMMARIZE_COMPACTOR_NAME,
          version: SUMMARIZE_COMPACTOR_VERSION,
          parameters: {
            retainRecentExchanges: RETAIN_RECENT_EXCHANGES,
            model: opts.source.model,
            // CL-3837/CL-3838: ride usage + source on open parameters so the
            // reactor can emit custom.compaction without reconciling the
            // summarizer's private seq space with the reactor's.
            ...(summaryUsage !== undefined ? { usage: summaryUsage } : {}),
            ...(summarySource !== undefined ? { source: summarySource } : {}),
            summaryChars,
          },
          reason: ctx.trigger,
          decisions: {
            kept: tail.length,
            dropped: turns.length - tail.length,
            summarized: 1,
          },
        },
      };
    },
  };
}
