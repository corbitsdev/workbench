/**
 * Firecrawl extract tools.
 *
 * Extract is a long-running, job-based endpoint: a `start` call submits one or
 * more URLs (plus an optional prompt and JSON Schema) and returns a job id, and
 * a `status` call polls that job for completion and the structured result. These
 * tools never block — the agent starts a job and polls it explicitly.
 */
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  ExtractStartArgsSchema,
  RequiredIdArgsSchema,
  firecrawlFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
} from "./shared";

export const FIRECRAWL_EXTRACT_START_DEFINITION: ToolDefinition = {
  name: "firecrawl_extract_start",
  description:
    "Start a Firecrawl extract job. Submits one or more URLs and returns a job id. Use firecrawl_extract_status to poll for the structured result. Provide a prompt and/or a JSON Schema to guide and shape the extracted data.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description:
          "URLs to extract data from. Wildcards like https://example.com/* are supported.",
      },
      prompt: {
        type: "string",
        description: "Natural-language instruction describing what to extract.",
      },
      schema: {
        type: "object",
        description:
          "JSON Schema describing the structure of the data to extract.",
      },
      enableWebSearch: {
        type: "boolean",
        description:
          "When true, Firecrawl may follow links outside the provided URLs to find data.",
      },
    },
    required: ["urls"],
  },
};

export const FIRECRAWL_EXTRACT_STATUS_DEFINITION: ToolDefinition = {
  name: "firecrawl_extract_status",
  description:
    "Get the status and result of a Firecrawl extract job started with firecrawl_extract_start. Returns the job status and, once complete, the extracted structured data.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The extract job id returned by firecrawl_extract_start.",
      },
    },
    required: ["id"],
  },
};

export const EXTRACT_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_EXTRACT_START_DEFINITION,
  FIRECRAWL_EXTRACT_STATUS_DEFINITION,
];

export function createExtractTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_EXTRACT_START_DEFINITION, async (rawArgs, signal) => {
      const args = parseArgs(
        ExtractStartArgsSchema,
        rawArgs,
        "firecrawl_extract_start",
      );

      const body: Record<string, unknown> = { urls: args.urls };
      if (args.prompt !== undefined) {
        body.prompt = args.prompt;
      }
      if (args.schema !== undefined) {
        body.schema = args.schema;
      }
      if (args.enableWebSearch !== undefined) {
        body.enableWebSearch = args.enableWebSearch;
      }

      return firecrawlFetchJSON(
        resolved,
        { method: "POST", path: "/extract", body },
        signal,
      );
    }),

    stringTool(FIRECRAWL_EXTRACT_STATUS_DEFINITION, async (rawArgs, signal) => {
      const { id } = parseArgs(
        RequiredIdArgsSchema,
        rawArgs,
        "firecrawl_extract_status",
      );
      return firecrawlFetchJSON(
        resolved,
        { method: "GET", path: `/extract/${encodeURIComponent(id)}` },
        signal,
      );
    }),
  ];
}
