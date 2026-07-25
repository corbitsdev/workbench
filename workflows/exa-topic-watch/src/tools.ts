import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

// Workflow-owned shaping tool: `exa-topic-watch`'s intake carries the watch
// topic under `topic` (shared, unrenamable, with `last30days_format_report_
// document`), while `exa_search`'s argument is `query` (shared, unrenamable,
// with attio-task-agent/competitor-analysis/last30days-research). Native
// selectors are same-key-only, so no selector can produce `query` from
// `topic` — this tool is the rename, kept private to exa-topic-watch rather
// than aliasing either shared tool.
export const EXA_TOPIC_WATCH_PREPARE_SEARCH_DEFINITION: ToolDefinition = {
  name: "exa_topic_watch_prepare_search",
  description:
    "Internal exa-topic-watch workflow helper. Renames the intake gate's `topic` field to exa_search's `query` argument so the fetch step can dispatch exa_search natively.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The watch topic captured by the intake gate.",
      },
    },
    required: ["topic"],
  },
};

function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function createPrepareSearchTool(): AgentTool {
  return {
    kind: "full",
    definition: EXA_TOPIC_WATCH_PREPARE_SEARCH_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const topic = args.topic;
      if (typeof topic !== "string" || topic.trim().length === 0) {
        return { callId: call.id, isError: true, content: "topic is required" };
      }
      return {
        callId: call.id,
        content: { query: topic.trim() },
      };
    },
  };
}

export function createExaTopicWatchTools(): AgentTool[] {
  return [createPrepareSearchTool()];
}
