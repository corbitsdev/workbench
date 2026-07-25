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

export const COMPETITOR_ANALYSIS_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "competitor_analysis_format_report_document",
    description:
      "Internal workflow helper. Pairs the researched company's URL with the synthesize agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The researched company's URL, used as the artifact title.",
        },
        reply: {
          type: "string",
          description: "The synthesize agent's competitor report text.",
        },
      },
      required: ["url", "reply"],
    },
  };

function createCompetitorAnalysisFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: COMPETITOR_ANALYSIS_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const url = args.url;
      const reply = args.reply;
      if (typeof url !== "string" || url.trim().length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: "url is required",
        };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: url.trim(), body: reply },
      };
    },
  };
}

/** Workflow-owned tools private to competitor-analysis. */
export function createCompetitorAnalysisTools(): AgentTool[] {
  return [createCompetitorAnalysisFormatReportDocumentTool()];
}
