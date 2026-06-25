import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  gammaFetchJSON,
  isRecord,
  resolveConfig,
  stringTool,
  type GammaToolsConfig,
  type ResolvedGammaConfig,
} from "./shared";

// Direct HTTP to Gamma SaaS API — see AGENTS.md 'Third-party generation APIs' and packages/tools-gamma/README.md
// Response shape: { data: Theme[], hasMore: boolean, nextCursor?: string }
async function listThemes(
  config: ResolvedGammaConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const result = await gammaFetchJSON(
    config,
    { method: "GET", path: "/themes" },
    signal,
  );

  if (!isRecord(result) || !Array.isArray(result["data"])) {
    return [];
  }

  return (result["data"] as unknown[]).map((item: unknown) => {
    if (!isRecord(item)) {
      return item;
    }
    return {
      id: item["id"],
      name: item["name"],
      type: item["type"] ?? null,
    };
  });
}

export const GAMMA_LIST_THEMES_DEFINITION: ToolDefinition = {
  name: "gamma_list_themes",
  description:
    "List available Gamma presentation themes. Returns an array of themes with id, name, and type. Used to find the Corbits theme ID for new decks.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const THEME_DEFINITIONS: ToolDefinition[] = [
  GAMMA_LIST_THEMES_DEFINITION,
];

export function createThemeTools(config: GammaToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);
  return [
    stringTool(GAMMA_LIST_THEMES_DEFINITION, (args, signal) =>
      listThemes(resolved, args, signal),
    ),
  ];
}
