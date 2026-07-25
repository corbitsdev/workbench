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

export const REDDIT_OPPORTUNITY_WATCH_FORMAT_DIGEST_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "reddit_opportunity_watch_format_digest_document",
    description:
      "Internal workflow helper. Pairs the intake search query with the digest agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field. Exists so reddit-opportunity-watch's intake `query` field (also consumed as-is by reddit_subreddit_search) can title the digest without renaming a shared formatter's `topic` arg.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The subreddit search query from intake, used as the artifact title.",
        },
        reply: {
          type: "string",
          description: "The digest agent's synthesized report text.",
        },
      },
      required: ["query", "reply"],
    },
  };

function createRedditOpportunityWatchFormatDigestDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: REDDIT_OPPORTUNITY_WATCH_FORMAT_DIGEST_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const query = args.query;
      const reply = args.reply;
      if (typeof query !== "string" || query.trim().length === 0) {
        return { callId: call.id, isError: true, content: "query is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: query.trim(), body: reply },
      };
    },
  };
}

/** Workflow-owned tools private to reddit-opportunity-watch. */
export function createRedditOpportunityWatchTools(): AgentTool[] {
  return [createRedditOpportunityWatchFormatDigestDocumentTool()];
}
