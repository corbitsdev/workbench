/**
 * Map + Search tools for the Firecrawl tool package.
 *
 * - `firecrawl_map` (POST /map) discovers links on a site, optionally filtered
 *   by a search term.
 * - `firecrawl_search` (POST /search) runs a web/news/image search, optionally
 *   scraping each result via `scrapeOptions`.
 *
 * Both tools are synchronous: the handler issues a single request and returns
 * the raw parsed JSON. Input is validated; responses are passed through.
 */
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  MapArgsSchema,
  SearchArgsSchema,
  firecrawlFetchJSON,
  optionalPositiveInteger,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

const MAP_DEFAULT_LIMIT = 5000;
const MAP_MAX_LIMIT = 100000;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 100;

async function mapSite(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(MapArgsSchema, rawArgs, "firecrawl_map");

  const body: Record<string, unknown> = {
    url: args.url,
    limit: optionalPositiveInteger(args.limit, MAP_DEFAULT_LIMIT, MAP_MAX_LIMIT),
    ...(args.search !== undefined ? { search: args.search } : {}),
    ...(args.includeSubdomains !== undefined
      ? { includeSubdomains: args.includeSubdomains }
      : {}),
    ...(args.sitemapOnly === true ? { sitemap: "only" } : {}),
  };

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/map", body },
    signal,
  );
}

async function searchWeb(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SearchArgsSchema, rawArgs, "firecrawl_search");

  const body: Record<string, unknown> = {
    query: args.query,
    limit: optionalPositiveInteger(
      args.limit,
      SEARCH_DEFAULT_LIMIT,
      SEARCH_MAX_LIMIT,
    ),
    ...(args.sources !== undefined ? { sources: args.sources } : {}),
    ...(args.tbs !== undefined ? { tbs: args.tbs } : {}),
    ...(args.scrapeOptions !== undefined
      ? { scrapeOptions: args.scrapeOptions }
      : {}),
  };

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/search", body },
    signal,
  );
}

export const FIRECRAWL_MAP_DEFINITION: ToolDefinition = {
  name: "firecrawl_map",
  description:
    "Discover URLs on a website using Firecrawl. Returns a list of links, each with a URL and optional title and description. Use this to enumerate a site before scraping or to find pages matching a search term.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The base URL of the site to map.",
      },
      search: {
        type: "string",
        description:
          "Optional search term used to filter and rank discovered links.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of links to return (1-100000, default 5000).",
      },
      includeSubdomains: {
        type: "boolean",
        description:
          "Include links on subdomains of the target site. Default true.",
      },
      sitemapOnly: {
        type: "boolean",
        description:
          "Only return links found in the site sitemap. Default false.",
      },
    },
    required: ["url"],
  },
};

export const FIRECRAWL_SEARCH_DEFINITION: ToolDefinition = {
  name: "firecrawl_search",
  description:
    "Search the web using Firecrawl. Returns results grouped by source (web, news, images). Provide scrapeOptions to scrape the content of each result. Use this to find current information or research topics.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string (max 500 characters).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-100, default 10).",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description:
          "Source types to search: web, news, images. Defaults to web.",
      },
      tbs: {
        type: "string",
        description:
          "Time-based search filter (e.g. qdr:d for past day, qdr:w for past week).",
      },
      scrapeOptions: {
        type: "object",
        description:
          "Firecrawl scrape options applied to each result to fetch its content.",
      },
    },
    required: ["query"],
  },
};

export const MAP_SEARCH_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_MAP_DEFINITION,
  FIRECRAWL_SEARCH_DEFINITION,
];

export function createMapSearchTools(
  config: FirecrawlToolsConfig,
): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_MAP_DEFINITION, (args, signal) =>
      mapSite(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_SEARCH_DEFINITION, (args, signal) =>
      searchWeb(resolved, args, signal),
    ),
  ];
}
