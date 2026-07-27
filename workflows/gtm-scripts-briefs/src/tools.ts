import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

// Workflow-owned shaping tool: `write_artifact`'s `data` argument is a
// nested object mixing literal constants (`workflowKind`, `artifactKind`,
// `jobLabel`) with intake fields (`topic`, `days`, `audience`, `objective`)
// and the writer's `reply`. Native selectors (`from`/`project`/`merge`/
// `literal` — `interchange/packages/workflow/src/definition/selectors.ts`)
// can only combine whole objects at the top level; none of them can build a
// nested object from mixed literal-and-dynamic per-key values. This tool
// does that one reshape, kept private to gtm-scripts-briefs rather than
// touching the shared `write_artifact` contract.
export const GTM_SCRIPTS_BRIEFS_PREPARE_PERSIST_DEFINITION: ToolDefinition = {
  name: "gtm_scripts_briefs_prepare_persist",
  description:
    "Internal gtm-scripts-briefs workflow helper. Shapes the intake fields, the writer's reply, and workflow constants into write_artifact's exact argument shape (title, body, kind, data, jobLabel).",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "The researched GTM topic." },
      days: { type: "number", description: "The research window in days." },
      audience: {
        type: "string",
        description: "Optional target audience captured at intake.",
      },
      objective: {
        type: "string",
        description: "Optional deliverable objective captured at intake.",
      },
      reply: {
        type: "string",
        description: "The writer agent's full deliverable text.",
      },
      workflowKind: {
        type: "string",
        description: "This workflow's kind identifier.",
      },
      artifactKind: {
        type: "string",
        description:
          "The artifact kind, used both as the top-level `kind` and inside `data.artifactKind`.",
      },
      jobLabel: {
        type: "string",
        description: "Display name for the gallery tile.",
      },
    },
    required: [
      "topic",
      "days",
      "reply",
      "workflowKind",
      "artifactKind",
      "jobLabel",
    ],
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

function requireString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function createPreparePersistTool(): AgentTool {
  return {
    kind: "full",
    definition: GTM_SCRIPTS_BRIEFS_PREPARE_PERSIST_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const topic = requireString(args, "topic");
      const reply = requireString(args, "reply");
      const workflowKind = requireString(args, "workflowKind");
      const artifactKind = requireString(args, "artifactKind");
      const jobLabel = requireString(args, "jobLabel");
      const days = args.days;
      if (topic === undefined || topic.trim().length === 0) {
        return { callId: call.id, isError: true, content: "topic is required" };
      }
      if (reply === undefined || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      if (typeof days !== "number") {
        return { callId: call.id, isError: true, content: "days is required" };
      }
      if (
        workflowKind === undefined ||
        artifactKind === undefined ||
        jobLabel === undefined
      ) {
        return {
          callId: call.id,
          isError: true,
          content: "workflowKind, artifactKind, and jobLabel are required",
        };
      }
      const audience = requireString(args, "audience");
      const objective = requireString(args, "objective");
      const data: Record<string, unknown> = {
        workflowKind,
        topic,
        days,
        artifactKind,
      };
      if (audience !== undefined) data.audience = audience;
      if (objective !== undefined) data.objective = objective;
      return {
        callId: call.id,
        content: {
          title: topic,
          body: reply,
          kind: artifactKind,
          data,
          jobLabel,
        },
      };
    },
  };
}

export function createGtmScriptsBriefsTools(): AgentTool[] {
  return [createPreparePersistTool()];
}
