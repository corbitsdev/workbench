import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  formatHeartbeatBriefDocument,
  formatHeartbeatBriefTitle,
  morningBriefNotifyMail,
} from "@workbench/shared";

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

export const HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_notify",
  description:
    "Internal heartbeat workflow helper. Builds the morning-brief notify mail's exact mail_send argument shape ({ to, subject, content, refs }) from the firing user's address, the composed brief document, and the persisted artifact id, so the notify step reads this tool's output verbatim.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "The firing user's usr_ mail address.",
      },
      title: {
        type: "string",
        description: "The brief's display title (mail subject).",
      },
      body: {
        type: "string",
        description: "The brief's body (mail content).",
      },
      artifactId: {
        type: "string",
        description: "Persisted morning-brief artifact id from write_artifact.",
      },
      runId: {
        type: "string",
        description:
          "Workflow run id from the hub trigger payload (same as mail messageId).",
      },
      workflowLabel: {
        type: "string",
        description:
          "Display label for the workflow_run ref (defaults to Company Heartbeat).",
      },
    },
    required: ["userAddress", "title", "body", "artifactId", "runId"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_document",
  description:
    "Internal heartbeat workflow helper. Pairs the title step's title with the brief agent's reply into the { title, body } shape write_artifact and the notify-mail step expect, so neither downstream step reshapes the agent's reply field.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The brief's display title from heartbeat_format_brief_title.",
      },
      reply: {
        type: "string",
        description: "The brief agent's synthesized reply text.",
      },
    },
    required: ["title", "reply"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_title",
  description:
    'Internal heartbeat workflow helper. Formats the morning brief\'s display name as "<User>\'s Morning Brief - DD/MM/YY" (falls back to "Your Morning Brief - DD/MM/YY" when no display name is known), for use as both the notify mail subject and the persisted artifact title.',
  inputSchema: {
    type: "object",
    properties: {
      userDisplayName: {
        type: "string",
        description: "The firing user's display name, if known.",
      },
    },
  },
};

function createHeartbeatFormatBriefNotifyTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userAddress = args.userAddress;
      const title = args.title;
      const body = args.body;
      const artifactId = args.artifactId;
      const runId = args.runId;
      const workflowLabel =
        typeof args.workflowLabel === "string" ? args.workflowLabel : undefined;
      for (const [name, value] of [
        ["userAddress", userAddress],
        ["title", title],
        ["body", body],
        ["artifactId", artifactId],
        ["runId", runId],
      ] as const) {
        if (typeof value !== "string" || value.trim().length === 0) {
          return {
            callId: call.id,
            isError: true,
            content: `${name} is required`,
          };
        }
      }
      try {
        const content = morningBriefNotifyMail({
          userAddress: userAddress as string,
          title: title as string,
          body: body as string,
          artifactId: artifactId as string,
          runId: runId as string,
          ...(workflowLabel !== undefined ? { workflowLabel } : {}),
        });
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const title = args.title;
      const reply = args.reply;
      if (typeof title !== "string" || title.trim().length === 0) {
        return { callId: call.id, isError: true, content: "title is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      try {
        const content = formatHeartbeatBriefDocument(title, reply);
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefTitleTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userDisplayName =
        typeof args.userDisplayName === "string"
          ? args.userDisplayName
          : undefined;
      const title = formatHeartbeatBriefTitle(userDisplayName, Date.now());
      return { callId: call.id, content: { title } };
    },
  };
}

/** Workflow-owned tools private to heartbeat. */
export function createHeartbeatTools(): AgentTool[] {
  return [
    createHeartbeatFormatBriefTitleTool(),
    createHeartbeatFormatBriefDocumentTool(),
    createHeartbeatFormatBriefNotifyTool(),
  ];
}
