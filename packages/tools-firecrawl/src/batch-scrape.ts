/**
 * Firecrawl batch-scrape tools.
 *
 * Batch scraping is job-based: you start a job for a list of URLs and then poll
 * its status, inspect errors, or cancel it. These four tools wrap Firecrawl's
 * `/batch/scrape` endpoints and pass parsed JSON straight through.
 */
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  BatchScrapeStartArgsSchema,
  RequiredIdArgsSchema,
  firecrawlFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

export const FIRECRAWL_BATCH_SCRAPE_START_DEFINITION: ToolDefinition = {
  name: "firecrawl_batch_scrape_start",
  description:
    "Start a batch scrape job for a list of URLs. Returns a job id you can use to poll status, fetch errors, or cancel. Use this to scrape many pages at once.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "The list of URLs to scrape.",
      },
      scrapeOptions: {
        type: "object",
        description:
          "Optional Firecrawl scrape options applied to every URL (formats, onlyMainContent, includeTags, excludeTags, waitFor, timeout, etc.).",
      },
    },
    required: ["urls"],
  },
};

export const FIRECRAWL_BATCH_SCRAPE_STATUS_DEFINITION: ToolDefinition = {
  name: "firecrawl_batch_scrape_status",
  description:
    "Get the status and results of a batch scrape job by its id. Returns job state, progress counts, credits used, and scraped page data.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The batch scrape job id returned by firecrawl_batch_scrape_start.",
      },
    },
    required: ["id"],
  },
};

export const FIRECRAWL_BATCH_SCRAPE_ERRORS_DEFINITION: ToolDefinition = {
  name: "firecrawl_batch_scrape_errors",
  description:
    "Get the errors for a batch scrape job by its id. Returns failed scrape attempts and URLs blocked by robots.txt.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The batch scrape job id returned by firecrawl_batch_scrape_start.",
      },
    },
    required: ["id"],
  },
};

export const FIRECRAWL_BATCH_SCRAPE_CANCEL_DEFINITION: ToolDefinition = {
  name: "firecrawl_batch_scrape_cancel",
  description: "Cancel a running batch scrape job by its id.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The batch scrape job id returned by firecrawl_batch_scrape_start.",
      },
    },
    required: ["id"],
  },
};

export const BATCH_SCRAPE_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_BATCH_SCRAPE_START_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_STATUS_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_ERRORS_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_CANCEL_DEFINITION,
];

async function startBatchScrape(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    BatchScrapeStartArgsSchema,
    rawArgs,
    "firecrawl_batch_scrape_start",
  );

  const body: Record<string, unknown> = {
    urls: args.urls,
    ...(args.scrapeOptions !== undefined ? args.scrapeOptions : {}),
  };

  return firecrawlFetchJSON(
    config,
    { method: "POST", path: "/batch/scrape", body },
    signal,
  );
}

async function batchScrapeStatus(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { id } = parseArgs(
    RequiredIdArgsSchema,
    rawArgs,
    "firecrawl_batch_scrape_status",
  );
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: `/batch/scrape/${encodeURIComponent(id)}` },
    signal,
  );
}

async function batchScrapeErrors(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { id } = parseArgs(
    RequiredIdArgsSchema,
    rawArgs,
    "firecrawl_batch_scrape_errors",
  );
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: `/batch/scrape/${encodeURIComponent(id)}/errors` },
    signal,
  );
}

async function cancelBatchScrape(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { id } = parseArgs(
    RequiredIdArgsSchema,
    rawArgs,
    "firecrawl_batch_scrape_cancel",
  );
  return firecrawlFetchJSON(
    config,
    { method: "DELETE", path: `/batch/scrape/${encodeURIComponent(id)}` },
    signal,
  );
}

export function createBatchScrapeTools(
  config: FirecrawlToolsConfig,
): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_BATCH_SCRAPE_START_DEFINITION, (args, signal) =>
      startBatchScrape(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_BATCH_SCRAPE_STATUS_DEFINITION, (args, signal) =>
      batchScrapeStatus(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_BATCH_SCRAPE_ERRORS_DEFINITION, (args, signal) =>
      batchScrapeErrors(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_BATCH_SCRAPE_CANCEL_DEFINITION, (args, signal) =>
      cancelBatchScrape(resolved, args, signal),
    ),
  ];
}
