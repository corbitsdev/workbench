/**
 * Firecrawl crawl tools.
 *
 * Crawling is a long-running, job-based operation: a start call returns a job
 * id, and separate calls report status, list active jobs, surface errors, and
 * cancel. These tools never block or poll internally — the agent decides when
 * to check on a job. A params-preview tool turns a natural-language prompt into
 * the crawl parameters Firecrawl would use, without starting a crawl.
 *
 * All endpoints are Firecrawl v2. The base URL in `./shared` already includes
 * `/v2`, so paths here begin at `/crawl`.
 */
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  firecrawlFetchJSON,
  optionalBoolean,
  optionalPositiveInteger,
  optionalRecord,
  optionalStringArray,
  requiredString,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

const MAX_LIMIT = 50_000;
const MAX_DEPTH = 50;
const LIMIT_FALLBACK = 10_000;
const DEPTH_FALLBACK = 10;

function buildCrawlStartBody(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const url = requiredString(args, "url");
  const includePaths = optionalStringArray(args.includePaths);
  const excludePaths = optionalStringArray(args.excludePaths);
  const allowBackwardLinks = optionalBoolean(args.allowBackwardLinks);
  const scrapeOptions = optionalRecord(args.scrapeOptions);

  const body: Record<string, unknown> = { url };

  if (typeof args.limit === "number") {
    body.limit = optionalPositiveInteger(args.limit, LIMIT_FALLBACK, MAX_LIMIT);
  }
  if (typeof args.maxDepth === "number") {
    body.maxDiscoveryDepth = optionalPositiveInteger(
      args.maxDepth,
      DEPTH_FALLBACK,
      MAX_DEPTH,
    );
  }
  if (includePaths !== null) {
    body.includePaths = includePaths;
  }
  if (excludePaths !== null) {
    body.excludePaths = excludePaths;
  }
  if (allowBackwardLinks !== null) {
    body.crawlEntireDomain = allowBackwardLinks;
  }
  if (scrapeOptions !== null) {
    body.scrapeOptions = scrapeOptions;
  }

  return body;
}

async function crawlStart(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/crawl", body: buildCrawlStartBody(args) },
    signal,
  );
}

async function crawlStatus(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const id = requiredString(args, "id");
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: `/crawl/${encodeURIComponent(id)}` },
    signal,
  );
}

async function crawlActive(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: "/crawl/active" },
    signal,
  );
}

async function crawlErrors(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const id = requiredString(args, "id");
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: `/crawl/${encodeURIComponent(id)}/errors` },
    signal,
  );
}

async function crawlCancel(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const id = requiredString(args, "id");
  return firecrawlFetchJSON(
    config,
    { method: "DELETE", path: `/crawl/${encodeURIComponent(id)}` },
    signal,
  );
}

async function crawlParamsPreview(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const url = requiredString(args, "url");
  const prompt = requiredString(args, "prompt");
  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/crawl/params-preview", body: { url, prompt } },
    signal,
  );
}

export const FIRECRAWL_CRAWL_START_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_start",
  description:
    "Start a Firecrawl crawl job over a website. Returns a job id immediately; the crawl runs asynchronously. Use firecrawl_crawl_status to check progress and retrieve results. Does not block.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The base URL to start crawling from.",
      },
      limit: {
        type: "number",
        description: "Maximum number of pages to crawl (default 10000).",
      },
      maxDepth: {
        type: "number",
        description: "Maximum crawl depth based on discovery order.",
      },
      includePaths: {
        type: "array",
        items: { type: "string" },
        description:
          "URL pathname regex patterns; only matching URLs are crawled.",
      },
      excludePaths: {
        type: "array",
        items: { type: "string" },
        description: "URL pathname regex patterns; matching URLs are skipped.",
      },
      allowBackwardLinks: {
        type: "boolean",
        description:
          "Allow following internal links to sibling or parent URLs, not just child paths (crawl entire domain).",
      },
      scrapeOptions: {
        type: "object",
        description:
          "Scrape options applied to each crawled page (formats, content extraction).",
      },
    },
    required: ["url"],
  },
};

export const FIRECRAWL_CRAWL_STATUS_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_status",
  description:
    "Get the status and results of a Firecrawl crawl job by id. Returns status, totals, credits used, and crawled page data.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The crawl job id returned by firecrawl_crawl_start.",
      },
    },
    required: ["id"],
  },
};

export const FIRECRAWL_CRAWL_ACTIVE_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_active",
  description: "List currently active Firecrawl crawl jobs.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const FIRECRAWL_CRAWL_ERRORS_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_errors",
  description: "Get the errors encountered during a Firecrawl crawl job by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The crawl job id to fetch errors for.",
      },
    },
    required: ["id"],
  },
};

export const FIRECRAWL_CRAWL_CANCEL_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_cancel",
  description: "Cancel a running Firecrawl crawl job by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The crawl job id to cancel.",
      },
    },
    required: ["id"],
  },
};

export const FIRECRAWL_CRAWL_PARAMS_PREVIEW_DEFINITION: ToolDefinition = {
  name: "firecrawl_crawl_params_preview",
  description:
    "Preview the crawl parameters Firecrawl would derive from a natural-language prompt for a given URL, without starting a crawl.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL the crawl would target.",
      },
      prompt: {
        type: "string",
        description: "Natural-language description of what to crawl.",
      },
    },
    required: ["url", "prompt"],
  },
};

export const CRAWL_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_CRAWL_START_DEFINITION,
  FIRECRAWL_CRAWL_STATUS_DEFINITION,
  FIRECRAWL_CRAWL_ACTIVE_DEFINITION,
  FIRECRAWL_CRAWL_ERRORS_DEFINITION,
  FIRECRAWL_CRAWL_CANCEL_DEFINITION,
  FIRECRAWL_CRAWL_PARAMS_PREVIEW_DEFINITION,
];

export function createCrawlTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_CRAWL_START_DEFINITION, (args, signal) =>
      crawlStart(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_CRAWL_STATUS_DEFINITION, (args, signal) =>
      crawlStatus(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_CRAWL_ACTIVE_DEFINITION, (args, signal) =>
      crawlActive(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_CRAWL_ERRORS_DEFINITION, (args, signal) =>
      crawlErrors(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_CRAWL_CANCEL_DEFINITION, (args, signal) =>
      crawlCancel(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_CRAWL_PARAMS_PREVIEW_DEFINITION, (args, signal) =>
      crawlParamsPreview(resolved, args, signal),
    ),
  ];
}
