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

const SUMMARY_MODEL_ID: string = summaryDefaultModel;

export type CreateSummarizeCompactorOpts = {
  // The agent's own inference source. Its model is overridden with the
  // summary agent's model (`deepseek-v4-flash`) so the compaction call
  // reuses the agent's already-resolved openai-compatible provider,
  // credential, and endpoint (the workbench opencode-zen deployment
  // serves that model on the same source) rather than requiring a
  // second, separately-provisioned inference source just for compaction.
  source: InferenceSource;
  deps: Dependencies;
};

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

function retainedTail(turns: ConversationTurn[]): ConversationTurn[] {
  const exchanges = splitIntoExchanges(turns);
  const tailExchanges = exchanges.slice(-RETAIN_RECENT_EXCHANGES);
  const tail = tailExchanges.flat();
  return dropLeadingOrphanToolResult(tail);
}

function renderTurnsAsText(turns: ConversationTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") {
        lines.push(`${turn.role}: ${block.text}`);
      } else if (block.type === "tool_call") {
        lines.push(
          `${turn.role}: [called tool ${block.name} with ${JSON.stringify(block.arguments)}]`,
        );
      } else if (block.type === "tool_result") {
        lines.push(`${turn.role}: [tool result for ${block.callId}]`);
      }
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
  const summarySource: InferenceSource = {
    ...opts.source,
    model: SUMMARY_MODEL_ID,
  };

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
      try {
        for await (const event of runInference({
          turns: [systemTurn, conversationTurn],
          source: summarySource,
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
          }
        }
      } catch {
        return unchangedResult(turns, "summarize-inference-failed");
      }

      if (summaryText === undefined || summaryText.trim().length === 0) {
        return unchangedResult(turns, "summarize-inference-empty");
      }

      const summaryTurn: ConversationTurn = {
        role: "assistant",
        content: [{ type: "text", text: summaryText }],
        model: summarySource.model,
        timestamp: Date.now(),
      };

      const tail = retainedTail(turns);
      const output = [summaryTurn, ...tail];

      return {
        output,
        record: {
          strategy: SUMMARIZE_COMPACTOR_NAME,
          version: SUMMARIZE_COMPACTOR_VERSION,
          parameters: {
            retainRecentExchanges: RETAIN_RECENT_EXCHANGES,
            model: summarySource.model,
          },
          reason: ctx.trigger,
          decisions: {
            kept: tail.length + 1,
            dropped: turns.length - tail.length,
          },
        },
      };
    },
  };
}
