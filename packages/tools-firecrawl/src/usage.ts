import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  ActivityArgsSchema,
  HistoricalCreditUsageArgsSchema,
  firecrawlFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

async function creditUsage(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: "/team/credit-usage" },
    signal,
  );
}

async function historicalCreditUsage(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    HistoricalCreditUsageArgsSchema,
    rawArgs,
    "firecrawl_historical_credit_usage",
  );

  return firecrawlFetchJSON(
    config,
    {
      method: "GET",
      path: "/team/credit-usage/historical",
      ...(args.byApiKey !== undefined
        ? { query: { byApiKey: args.byApiKey } }
        : {}),
    },
    signal,
  );
}

async function tokenUsage(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: "/team/token-usage" },
    signal,
  );
}

async function historicalTokenUsage(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: "/team/token-usage/historical" },
    signal,
  );
}

async function activity(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ActivityArgsSchema, rawArgs, "firecrawl_activity");

  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.endpoint !== undefined && args.endpoint.length > 0) {
    query.endpoint = args.endpoint;
  }
  if (args.limit !== undefined) {
    query.limit = args.limit;
  }
  if (args.cursor !== undefined && args.cursor.length > 0) {
    query.cursor = args.cursor;
  }

  return firecrawlFetchJSON(
    config,
    {
      method: "GET",
      path: "/team/activity",
      query: Object.keys(query).length > 0 ? query : undefined,
    },
    signal,
  );
}

export const FIRECRAWL_CREDIT_USAGE_DEFINITION: ToolDefinition = {
  name: "firecrawl_credit_usage",
  description:
    "Get current Firecrawl credit usage for the authenticated team, including remaining credits, plan credits, and billing period dates.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const FIRECRAWL_HISTORICAL_CREDIT_USAGE_DEFINITION: ToolDefinition = {
  name: "firecrawl_historical_credit_usage",
  description:
    "Get historical Firecrawl credit usage by billing period for the authenticated team. Optionally break usage down by API key.",
  inputSchema: {
    type: "object",
    properties: {
      byApiKey: {
        type: "boolean",
        description:
          "When true, break historical credit usage down by API key.",
      },
    },
  },
};

export const FIRECRAWL_TOKEN_USAGE_DEFINITION: ToolDefinition = {
  name: "firecrawl_token_usage",
  description: "Get current Firecrawl token usage for the authenticated team.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const FIRECRAWL_HISTORICAL_TOKEN_USAGE_DEFINITION: ToolDefinition = {
  name: "firecrawl_historical_token_usage",
  description:
    "Get historical Firecrawl token usage by billing period for the authenticated team.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const FIRECRAWL_ACTIVITY_DEFINITION: ToolDefinition = {
  name: "firecrawl_activity",
  description:
    "Get Firecrawl team activity log. Optionally filter by endpoint, limit results, or paginate with a cursor.",
  inputSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        description:
          'Filter activity by endpoint name (e.g. "scrape", "crawl").',
      },
      limit: {
        type: "number",
        description: "Maximum number of activity records to return.",
      },
      cursor: {
        type: "string",
        description: "Cursor for pagination from a previous response.",
      },
    },
  },
};

export const USAGE_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_CREDIT_USAGE_DEFINITION,
  FIRECRAWL_HISTORICAL_CREDIT_USAGE_DEFINITION,
  FIRECRAWL_TOKEN_USAGE_DEFINITION,
  FIRECRAWL_HISTORICAL_TOKEN_USAGE_DEFINITION,
  FIRECRAWL_ACTIVITY_DEFINITION,
];

export function createUsageTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_CREDIT_USAGE_DEFINITION, (args, signal) =>
      creditUsage(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_HISTORICAL_CREDIT_USAGE_DEFINITION, (args, signal) =>
      historicalCreditUsage(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_TOKEN_USAGE_DEFINITION, (args, signal) =>
      tokenUsage(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_HISTORICAL_TOKEN_USAGE_DEFINITION, (args, signal) =>
      historicalTokenUsage(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_ACTIVITY_DEFINITION, (args, signal) =>
      activity(resolved, args, signal),
    ),
  ];
}
