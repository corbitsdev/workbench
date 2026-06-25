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
  firecrawlFetchJSON,
  optionalBoolean,
  optionalPositiveInteger,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredString,
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
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const url = requiredString(args, "url");
  const search = optionalString(args.search);
  const includeSubdomains = optionalBoolean(args.includeSubdomains);
  const sitemapOnly = optionalBoolean(args.sitemapOnly);

  const body: Record<string, unknown> = {
    url,
    limit: optionalPositiveInteger(
      args.limit,
      MAP_DEFAULT_LIMIT,
      MAP_MAX_LIMIT,
    ),
    ...(search !== null ? { search } : {}),
    ...(includeSubdomains !== null ? { includeSubdomains } : {}),
    ...(sitemapOnly === true ? { sitemap: "only" } : {}),
  };

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/map", body },
    signal,
  );
}

async function searchWeb(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const query = requiredString(args, "query");
  const sources = optionalStringArray(args.sources);
  const tbs = optionalString(args.tbs);
  const scrapeOptions = optionalRecord(args.scrapeOptions);

  const body: Record<string, unknown> = {
    query,
    limit: optionalPositiveInteger(
      args.limit,
      SEARCH_DEFAULT_LIMIT,
      SEARCH_MAX_LIMIT,
    ),
    ...(sources !== null ? { sources } : {}),
    ...(tbs !== null ? { tbs } : {}),
    ...(scrapeOptions !== null ? { scrapeOptions } : {}),
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
