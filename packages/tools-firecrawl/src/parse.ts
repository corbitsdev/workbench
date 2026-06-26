import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  ParseArgsSchema,
  errorMessageFromBody,
  normalizeBaseUrl,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

async function parseDocument(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ParseArgsSchema, rawArgs, "firecrawl_parse");

  const fetcher = config.fetcher ?? fetch;

  // Download the document
  const fileResponse = await fetcher(args.url, { signal });
  if (!fileResponse.ok) {
    throw new Error(
      `Failed to fetch document: ${fileResponse.status} ${fileResponse.statusText}`,
    );
  }
  const blob = await fileResponse.blob();

  // Build multipart form
  const form = new FormData();
  form.append("file", blob, "document");
  if (args.options !== undefined) {
    form.append("options", JSON.stringify(args.options));
  }

  // POST to /parse
  const parseUrl = new URL(`${normalizeBaseUrl(config.baseUrl)}/parse`);
  const response = await fetcher(parseUrl.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal,
  });

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ""));
    throw new Error(`Firecrawl API error: ${response.status} ${body ?? ""}`);
  }

  return (await response.json()) as unknown;
}

export const FIRECRAWL_PARSE_DEFINITION: ToolDefinition = {
  name: "firecrawl_parse",
  description:
    "Parse a document (PDF, DOCX, XLSX, HTML) with Firecrawl and return clean, LLM-ready content. Provide a URL to the document and optional parse options.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the document to parse (PDF, DOCX, XLSX, HTML).",
      },
      options: {
        type: "object",
        description:
          "Optional parse options, e.g. formats, onlyMainContent, includeTags, excludeTags, timeout, parsers.",
      },
    },
    required: ["url"],
  },
};

export const PARSE_DEFINITIONS: ToolDefinition[] = [FIRECRAWL_PARSE_DEFINITION];

export function createParseTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_PARSE_DEFINITION, (args, signal) =>
      parseDocument(resolved, args, signal),
    ),
  ];
}
