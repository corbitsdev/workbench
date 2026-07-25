import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

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

export const GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_DEFINITION: ToolDefinition =
  {
    name: "github_topic_watch_format_activity_query",
    description:
      "Internal github-topic-watch workflow helper. Renames the intake `topic` field to github_activity's `query` argument and stamps a fixed 7-day lookback, so the fetch step's input matches github_activity's argument names exactly (native action selectors are same-key-only and cannot rename).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The watch topic from intake.",
        },
      },
      required: ["topic"],
    },
  };

function createGithubTopicWatchFormatActivityQueryTool(): AgentTool {
  return {
    kind: "full",
    definition: GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const topic = args.topic;
      if (typeof topic !== "string" || topic.trim().length === 0) {
        return { callId: call.id, isError: true, content: "topic is required" };
      }
      return {
        callId: call.id,
        content: { query: topic.trim(), days: 7 },
      };
    },
  };
}

/** Workflow-owned tools private to github-topic-watch. */
export function createGithubTopicWatchTools(): AgentTool[] {
  return [createGithubTopicWatchFormatActivityQueryTool()];
}
