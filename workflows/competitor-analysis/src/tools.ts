import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { parseCompetitorReport } from "./parse";

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

const REVIEW_GATE_OPTIONS = [
  { id: "approve", label: "Approve & save", payload: { approved: true } },
  { id: "reject", label: "Reject", payload: { approved: false } },
];

const REVIEW_GATE_FALLBACK_PROMPT =
  "Couldn't read the competitor report. You can still reject this run.";

export const COMPETITOR_ANALYSIS_BUILD_REVIEW_GATE_DEFINITION: ToolDefinition =
  {
    name: "competitor_analysis_build_review_gate",
    description:
      "Internal workflow helper. Builds the review gate's choice block from the synthesize agent's raw reply, embedding the competitor report so the operator can approve or reject with the report visible. Never fails — a report that can't be decoded still renders the Approve/Reject choice.",
    inputSchema: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: "The synthesize agent's raw reply text.",
        },
      },
      required: ["reply"],
    },
  };

function createCompetitorAnalysisBuildReviewGateTool(): AgentTool {
  return {
    kind: "full",
    definition: COMPETITOR_ANALYSIS_BUILD_REVIEW_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const reply = args.reply;
      if (typeof reply !== "string") {
        return {
          callId: call.id,
          isError: true,
          content: "reply is required",
        };
      }
      const decoded = parseCompetitorReport({ reply });
      if (decoded.status !== "ok") {
        return {
          callId: call.id,
          content: {
            kind: "choice",
            prompt: REVIEW_GATE_FALLBACK_PROMPT,
            options: REVIEW_GATE_OPTIONS,
          },
        };
      }
      return {
        callId: call.id,
        content: {
          kind: "choice",
          prompt: `${decoded.value.title}\n\n${decoded.value.content}`,
          options: REVIEW_GATE_OPTIONS,
        },
      };
    },
  };
}

/** Workflow-owned tools private to competitor-analysis. */
export function createCompetitorAnalysisTools(): AgentTool[] {
  return [
    createCompetitorAnalysisFormatReportDocumentTool(),
    createCompetitorAnalysisBuildReviewGateTool(),
  ];
}
