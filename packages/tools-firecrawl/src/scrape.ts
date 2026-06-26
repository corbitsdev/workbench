import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  ScrapeArgsSchema,
  firecrawlFetchJSON,
  optionalPositiveInteger,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

const MAX_WAIT_FOR_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

async function scrape(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ScrapeArgsSchema, rawArgs, "firecrawl_scrape");

  const waitFor = optionalPositiveInteger(args.waitFor, 0, MAX_WAIT_FOR_MS);
  const timeout = optionalPositiveInteger(args.timeout, 0, MAX_TIMEOUT_MS);

  const body: Record<string, unknown> = {
    url: args.url,
    ...(args.formats !== undefined ? { formats: args.formats } : {}),
    ...(args.onlyMainContent !== undefined
      ? { onlyMainContent: args.onlyMainContent }
      : {}),
    ...(args.includeTags !== undefined
      ? { includeTags: args.includeTags }
      : {}),
    ...(args.excludeTags !== undefined
      ? { excludeTags: args.excludeTags }
      : {}),
    ...(waitFor > 0 ? { waitFor } : {}),
    ...(timeout > 0 ? { timeout } : {}),
    ...(args.jsonOptions !== undefined
      ? { jsonOptions: args.jsonOptions }
      : {}),
  };

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/scrape", body },
    signal,
  );
}

export const FIRECRAWL_SCRAPE_DEFINITION: ToolDefinition = {
  name: "firecrawl_scrape",
  description:
    "Scrape a single web page with Firecrawl and return its content. Use this to fetch the readable contents of a known URL as markdown, HTML, links, a screenshot, or structured JSON.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of the page to scrape.",
      },
      formats: {
        type: "array",
        items: { type: "string" },
        description:
          "Output formats to return, e.g. markdown, html, rawHtml, links, screenshot, json. Defaults to markdown.",
      },
      onlyMainContent: {
        type: "boolean",
        description:
          "When true, return only the main content of the page, excluding headers, navs, and footers.",
      },
      includeTags: {
        type: "array",
        items: { type: "string" },
        description: "HTML tags or selectors to include in the output.",
      },
      excludeTags: {
        type: "array",
        items: { type: "string" },
        description: "HTML tags or selectors to exclude from the output.",
      },
      waitFor: {
        type: "number",
        description:
          "Milliseconds to wait before scraping, for pages that load content late.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-300000).",
      },
      jsonOptions: {
        type: "object",
        description:
          "Options for structured JSON extraction, such as a schema or prompt. Used when the json format is requested.",
      },
    },
    required: ["url"],
  },
};

export const SCRAPE_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_SCRAPE_DEFINITION,
];

export function createScrapeTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_SCRAPE_DEFINITION, (args, signal) =>
      scrape(resolved, args, signal),
    ),
  ];
}
