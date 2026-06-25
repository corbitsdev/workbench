import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  gammaFetchJSON,
  isRecord,
  optionalString,
  pollGeneration,
  requiredString,
  resolveConfig,
  stringTool,
  type GammaToolsConfig,
  type ResolvedGammaConfig,
} from "./shared";

const DuplicatePresentationArgsSchema = type({
  gammaId: "string > 0",
  "title?": "string > 0",
  "prompt?": "string > 0",
});

export type DuplicatePresentationArgs =
  typeof DuplicatePresentationArgsSchema.infer;

const DUPLICATE_DEFAULT_PROMPT =
  "Create an exact copy of this presentation, preserving all content, structure, and layout.";

// Direct HTTP to Gamma SaaS API — see AGENTS.md 'Third-party generation APIs' and packages/tools-gamma/README.md
// Gamma has no dedicated duplicate endpoint; duplication uses from-template with the existing gammaId.
async function duplicatePresentation(
  config: ResolvedGammaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const gammaId = requiredString(args, "gammaId");
  const title = optionalString(args["title"]);
  const prompt = optionalString(args["prompt"]) ?? DUPLICATE_DEFAULT_PROMPT;

  const body: Record<string, unknown> = {
    gammaId,
    prompt,
    ...(title !== null ? { title } : {}),
  };

  const response = await gammaFetchJSON(
    config,
    { method: "POST", path: "/generations/from-template", body },
    signal,
  );

  if (!isRecord(response)) {
    throw new Error("Unexpected response from Gamma generations API");
  }

  const generationId = response["generationId"];
  if (typeof generationId !== "string") {
    throw new Error("Gamma generation did not return a generationId");
  }

  const result = await pollGeneration(config, generationId, signal);
  return { gammaUrl: result.gammaUrl, gammaId: result.gammaId };
}

export const GAMMA_DUPLICATE_PRESENTATION_DEFINITION: ToolDefinition = {
  name: "gamma_duplicate_presentation",
  description:
    "Duplicate an existing Gamma presentation by its gammaId. Optionally provide a title and a prompt describing any changes. Defaults to an exact copy. Returns the new deck URL (gammaUrl) and its gammaId. Use this to fork a finished deck for iteration rather than regenerating from a template.",
  inputSchema: {
    type: "object",
    properties: {
      gammaId: {
        type: "string",
        description: "The Gamma presentation ID to duplicate.",
      },
      title: {
        type: "string",
        description: "Optional title for the duplicated deck.",
      },
      prompt: {
        type: "string",
        description:
          "Optional instructions for the copy. Defaults to an exact copy of the original.",
      },
    },
    required: ["gammaId"],
  },
};

export const PRESENTATION_DEFINITIONS: ToolDefinition[] = [
  GAMMA_DUPLICATE_PRESENTATION_DEFINITION,
];

export function createPresentationTools(config: GammaToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);
  return [
    stringTool(GAMMA_DUPLICATE_PRESENTATION_DEFINITION, (args, signal) =>
      duplicatePresentation(resolved, args, signal),
    ),
  ];
}
