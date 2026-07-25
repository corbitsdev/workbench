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

export const SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "sumble_account_intel_format_report_document",
    description:
      "Internal workflow helper. Pairs the researched account's organization domain with the synthesize agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
    inputSchema: {
      type: "object",
      properties: {
        organizationDomain: {
          type: "string",
          description:
            "The researched account's organization domain, used as the artifact title.",
        },
        reply: {
          type: "string",
          description:
            "The synthesize agent's account intelligence brief text.",
        },
      },
      required: ["organizationDomain", "reply"],
    },
  };

function createSumbleAccountIntelFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const organizationDomain = args.organizationDomain;
      const reply = args.reply;
      if (
        typeof organizationDomain !== "string" ||
        organizationDomain.trim().length === 0
      ) {
        return {
          callId: call.id,
          isError: true,
          content: "organizationDomain is required",
        };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: organizationDomain.trim(), body: reply },
      };
    },
  };
}

/** Workflow-owned tools private to sumble-account-intel. */
export function createSumbleAccountIntelTools(): AgentTool[] {
  return [createSumbleAccountIntelFormatReportDocumentTool()];
}
