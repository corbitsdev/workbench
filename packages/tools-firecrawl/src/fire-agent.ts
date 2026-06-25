import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  FireAgentArgsSchema,
  firecrawlFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

async function runAgent(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(FireAgentArgsSchema, rawArgs, "firecrawl_agent");

  const body: Record<string, unknown> = { prompt: args.prompt };
  if (args.schema !== undefined) {
    body.schema = args.schema;
  }

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/agent", body },
    signal,
  );
}

export const FIRECRAWL_AGENT_DEFINITION: ToolDefinition = {
  name: "firecrawl_agent",
  description:
    "Use Firecrawl's /agent endpoint to autonomously research the web and extract structured data. No URLs are required — just describe what you need. Provide an optional JSON Schema to shape the output.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Natural-language instruction describing what data to find and extract.",
      },
      schema: {
        type: "object",
        description:
          "Optional JSON Schema describing the structure of the data to return.",
      },
    },
    required: ["prompt"],
  },
};

export const FIRE_AGENT_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_AGENT_DEFINITION,
];

export function createFireAgentTools(
  config: FirecrawlToolsConfig,
): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_AGENT_DEFINITION, (args, signal) =>
      runAgent(resolved, args, signal),
    ),
  ];
}
