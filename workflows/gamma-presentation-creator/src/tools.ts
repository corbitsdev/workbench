import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

// Workflow-owned shaping tools (CL-4454): native `action` selectors
// (`from`/`project`/`merge`/`literal`) can select and combine fields but
// cannot rename one, so wherever this workflow's own agent-step output field
// names differ from a downstream tool's argument names, a small private tool
// does the rename — kept local to gamma-presentation-creator rather than
// aliasing a shared, multi-caller tool or renaming a shared tool's schema.

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

function readRequiredString(
  args: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  return typeof value === "string" ? value : "";
}

// `generate`'s draft is exposed as the agent step's standard `reply` field;
// `gamma_create_from_template`'s argument is `prompt`. Both names are
// load-bearing elsewhere (agent-step output convention; the Gamma tool's own
// documented API), so neither is renamed — this tool does the one-field
// rename instead.
export const GAMMA_PRESENTATION_CREATOR_PREPARE_RENDER_DEFINITION: ToolDefinition =
  {
    name: "gamma_presentation_creator_prepare_render",
    description:
      "Internal gamma-presentation-creator workflow helper. Renames the draft agent's `reply` field to gamma_create_from_template's `prompt` argument so the render step can dispatch it natively.",
    inputSchema: {
      type: "object",
      properties: {
        gammaId: {
          type: "string",
          description: "The template gammaId carried on the intake gate.",
        },
        reply: {
          type: "string",
          description: "The draft agent's generated deck content.",
        },
      },
      required: ["gammaId", "reply"],
    },
  };

// Pairs the intake gate's `deckTitle`, the describe agent's `reply`, and the
// render step's deck fields (`url`, `gammaId`, `exportUrl`) into
// `artifact_link_gamma_presentation`'s exact argument names (`title`,
// `description`, `pdfUrl`). `url`/`gammaId` already match the persist tool's
// argument names verbatim on `render`'s output; only `deckTitle` → `title`,
// `reply` → `description`, and `exportUrl` → `pdfUrl` are renames.
export const GAMMA_PRESENTATION_CREATOR_PREPARE_PERSIST_DEFINITION: ToolDefinition =
  {
    name: "gamma_presentation_creator_prepare_persist",
    description:
      "Internal gamma-presentation-creator workflow helper. Pairs the intake title, the describe agent's summary, and the rendered deck's url/gammaId/exportUrl into artifact_link_gamma_presentation's argument names.",
    inputSchema: {
      type: "object",
      properties: {
        deckTitle: { type: "string", description: "The intake deck title." },
        reply: {
          type: "string",
          description: "The describe agent's deck summary.",
        },
        url: { type: "string", description: "The rendered deck's URL." },
        gammaId: {
          type: "string",
          description: "The rendered deck's own gammaId.",
        },
        exportUrl: {
          type: "string",
          description: "The rendered deck's optional PDF export URL.",
        },
      },
      required: ["deckTitle", "reply", "url", "gammaId"],
    },
  };

function createPrepareRenderTool(): AgentTool {
  return {
    kind: "full",
    definition: GAMMA_PRESENTATION_CREATOR_PREPARE_RENDER_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const gammaId = readRequiredString(args, "gammaId");
      const reply = readRequiredString(args, "reply");
      if (gammaId === undefined) {
        return {
          callId: call.id,
          isError: true,
          content: "gammaId is required",
        };
      }
      if (reply === undefined) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { gammaId, prompt: reply },
      };
    },
  };
}

function createPreparePersistTool(): AgentTool {
  return {
    kind: "full",
    definition: GAMMA_PRESENTATION_CREATOR_PREPARE_PERSIST_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const deckTitle = readRequiredString(args, "deckTitle");
      const reply = readRequiredString(args, "reply");
      const url = readRequiredString(args, "url");
      const gammaId = readRequiredString(args, "gammaId");
      if (deckTitle === undefined) {
        return {
          callId: call.id,
          isError: true,
          content: "deckTitle is required",
        };
      }
      if (reply === undefined) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      if (url === undefined) {
        return { callId: call.id, isError: true, content: "url is required" };
      }
      if (gammaId === undefined) {
        return {
          callId: call.id,
          isError: true,
          content: "gammaId is required",
        };
      }
      const pdfUrl = optionalString(args, "exportUrl");
      return {
        callId: call.id,
        content: {
          title: deckTitle,
          description: reply,
          url,
          gammaId,
          pdfUrl,
        },
      };
    },
  };
}

export function createGammaPresentationCreatorTools(): AgentTool[] {
  return [createPrepareRenderTool(), createPreparePersistTool()];
}
