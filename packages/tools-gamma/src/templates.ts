import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  GENERATION_EXPORT_FORMAT,
  gammaFetchJSON,
  isRecord,
  optionalString,
  pollGeneration,
  requiredString,
  resolveConfig,
  stringTool,
  toDeckResult,
  WORKSPACE_SHARING_OPTIONS,
  type GammaDeckResult,
  type GammaToolsConfig,
  type GenerationResult,
  type ResolvedGammaConfig,
} from "./shared";

/** Call Gamma's from-template generation API directly from hub services. */
export async function generateFromTemplate(
  config: GammaToolsConfig,
  args: { gammaId: string; prompt: string; title?: string },
  signal: AbortSignal,
): Promise<GenerationResult> {
  const resolved = resolveConfig(config);
  const argsMap: Record<string, unknown> = {
    gammaId: args.gammaId,
    prompt: args.prompt,
  };
  if (args.title !== undefined) argsMap["title"] = args.title;
  return createFromTemplate(resolved, argsMap, signal);
}

// Direct HTTP to Gamma SaaS API — see AGENTS.md 'Third-party generation APIs' and packages/tools-gamma/README.md
async function createFromTemplate(
  config: ResolvedGammaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GammaDeckResult> {
  const gammaId = requiredString(args, "gammaId");
  const prompt = requiredString(args, "prompt");
  const title = optionalString(args["title"]);
  const themeId = optionalString(args["themeId"]);

  const body: Record<string, unknown> = {
    gammaId,
    prompt,
    ...(title !== null ? { title } : {}),
    ...(themeId !== null ? { themeId } : {}),
    exportAs: GENERATION_EXPORT_FORMAT,
    sharingOptions: WORKSPACE_SHARING_OPTIONS,
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
  // `toDeckResult` guarantees `gammaUrl`, `url`, `gammaId`, and `exportUrl` on
  // the output so the workflow's persist argMap (which reads `gammaUrl` and
  // `pdfUrl <- exportUrl` with a hard, no-fallback presence check) always
  // resolves. An empty `exportUrl` is treated as "no PDF" downstream.
  return toDeckResult(result);
}

// Tenant-owned templates are stored in the hub DB and listed via the
// hub-backed tool (GAMMA_TEMPLATES_HUB_TOOLS in apps/hub). This schema
// describes a single template as returned to the agent at runtime.
export const GammaTemplateSchema = type({
  id: "string",
  gammaId: "string",
  name: "string",
  description: "string",
});

export type GammaTemplate = typeof GammaTemplateSchema.infer;

export const GAMMA_LIST_TEMPLATES_DEFINITION: ToolDefinition = {
  name: "gamma_list_templates",
  description:
    "List tenant-owned Gamma presentation templates. Returns an array of templates with gammaId, name, and description. Use names when presenting options to the user; use gammaId internally when calling gamma_create_from_template.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const GAMMA_CREATE_FROM_TEMPLATE_DEFINITION: ToolDefinition = {
  name: "gamma_create_from_template",
  description:
    "Generate a new Gamma presentation based on an existing template presentation. Provide the gammaId of the template, a prompt describing the content to generate, and an optional title and themeId. Returns the new deck URL (gammaUrl) and its gammaId. This is an async operation that polls until the generation is complete.",
  inputSchema: {
    type: "object",
    properties: {
      gammaId: {
        type: "string",
        description:
          "The gammaId of the template presentation to generate from.",
      },
      prompt: {
        type: "string",
        description:
          "Instructions describing the content and structure of the new deck.",
      },
      title: {
        type: "string",
        description: "Optional title for the generated deck.",
      },
      themeId: {
        type: "string",
        description: "Optional theme ID to apply (from gamma_list_themes).",
      },
    },
    required: ["gammaId", "prompt"],
  },
};

export const TEMPLATE_DEFINITIONS: ToolDefinition[] = [
  GAMMA_LIST_TEMPLATES_DEFINITION,
  GAMMA_CREATE_FROM_TEMPLATE_DEFINITION,
];

// gamma_list_templates is excluded from this factory — it is its own
// hub-backed factory (`gammaTemplates` in interchange-tools.ts) that reads
// from the tenant DB rather than requiring Gamma API credentials.
export function createTemplateTools(config: GammaToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);
  return [
    stringTool(GAMMA_CREATE_FROM_TEMPLATE_DEFINITION, (args, signal) =>
      createFromTemplate(resolved, args, signal),
    ),
  ];
}
