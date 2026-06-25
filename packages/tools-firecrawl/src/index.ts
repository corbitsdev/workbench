import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  BATCH_SCRAPE_DEFINITIONS,
  createBatchScrapeTools,
} from "./batch-scrape";
import { BROWSER_DEFINITIONS, createBrowserTools } from "./browser";
import { CRAWL_DEFINITIONS, createCrawlTools } from "./crawl";
import { EXTRACT_DEFINITIONS, createExtractTools } from "./extract";
import { FIRE_AGENT_DEFINITIONS, createFireAgentTools } from "./fire-agent";
import { MAP_SEARCH_DEFINITIONS, createMapSearchTools } from "./map-search";
import { MONITOR_DEFINITIONS, createMonitorTools } from "./monitor";
import { PARSE_DEFINITIONS, createParseTools } from "./parse";
import { SCRAPE_DEFINITIONS, createScrapeTools } from "./scrape";
import { USAGE_DEFINITIONS, createUsageTools } from "./usage";
import type { FirecrawlToolsConfig } from "./shared";

export type { FirecrawlFetch, FirecrawlToolsConfig } from "./shared";
export { FIRECRAWL_DEFAULT_BASE_URL } from "./shared";
export {
  FIRECRAWL_SCRAPE_DEFINITION,
  SCRAPE_DEFINITIONS,
  createScrapeTools,
} from "./scrape";
export {
  FIRECRAWL_CRAWL_START_DEFINITION,
  FIRECRAWL_CRAWL_STATUS_DEFINITION,
  FIRECRAWL_CRAWL_ACTIVE_DEFINITION,
  FIRECRAWL_CRAWL_ERRORS_DEFINITION,
  FIRECRAWL_CRAWL_CANCEL_DEFINITION,
  FIRECRAWL_CRAWL_PARAMS_PREVIEW_DEFINITION,
  CRAWL_DEFINITIONS,
  createCrawlTools,
} from "./crawl";
export {
  FIRECRAWL_BATCH_SCRAPE_START_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_STATUS_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_ERRORS_DEFINITION,
  FIRECRAWL_BATCH_SCRAPE_CANCEL_DEFINITION,
  BATCH_SCRAPE_DEFINITIONS,
  createBatchScrapeTools,
} from "./batch-scrape";
export {
  FIRECRAWL_MAP_DEFINITION,
  FIRECRAWL_SEARCH_DEFINITION,
  MAP_SEARCH_DEFINITIONS,
  createMapSearchTools,
} from "./map-search";
export {
  FIRECRAWL_EXTRACT_START_DEFINITION,
  FIRECRAWL_EXTRACT_STATUS_DEFINITION,
  EXTRACT_DEFINITIONS,
  createExtractTools,
} from "./extract";
export {
  FIRECRAWL_AGENT_DEFINITION,
  FIRE_AGENT_DEFINITIONS,
  createFireAgentTools,
} from "./fire-agent";
export {
  FIRECRAWL_CREDIT_USAGE_DEFINITION,
  FIRECRAWL_HISTORICAL_CREDIT_USAGE_DEFINITION,
  FIRECRAWL_TOKEN_USAGE_DEFINITION,
  FIRECRAWL_HISTORICAL_TOKEN_USAGE_DEFINITION,
  FIRECRAWL_ACTIVITY_DEFINITION,
  USAGE_DEFINITIONS,
  createUsageTools,
} from "./usage";
export {
  FIRECRAWL_PARSE_DEFINITION,
  PARSE_DEFINITIONS,
  createParseTools,
} from "./parse";
export {
  FIRECRAWL_INTERACT_DEFINITION,
  FIRECRAWL_BROWSER_SESSIONS_LIST_DEFINITION,
  FIRECRAWL_BROWSER_SESSION_DELETE_DEFINITION,
  BROWSER_DEFINITIONS,
  createBrowserTools,
} from "./browser";
export {
  FIRECRAWL_MONITOR_CREATE_DEFINITION,
  FIRECRAWL_MONITOR_GET_DEFINITION,
  FIRECRAWL_MONITOR_UPDATE_DEFINITION,
  FIRECRAWL_MONITOR_DELETE_DEFINITION,
  FIRECRAWL_MONITOR_LIST_DEFINITION,
  FIRECRAWL_MONITOR_RUN_DEFINITION,
  FIRECRAWL_MONITOR_CHECK_DEFINITION,
  MONITOR_DEFINITIONS,
  createMonitorTools,
} from "./monitor";

export const FIRECRAWL_DEFINITIONS: ToolDefinition[] = [
  ...SCRAPE_DEFINITIONS,
  ...CRAWL_DEFINITIONS,
  ...BATCH_SCRAPE_DEFINITIONS,
  ...MAP_SEARCH_DEFINITIONS,
  ...EXTRACT_DEFINITIONS,
  ...FIRE_AGENT_DEFINITIONS,
  ...USAGE_DEFINITIONS,
  ...PARSE_DEFINITIONS,
  ...BROWSER_DEFINITIONS,
  ...MONITOR_DEFINITIONS,
];

export function createFirecrawlTools(
  config: FirecrawlToolsConfig,
): AgentTool[] {
  return [
    ...createScrapeTools(config),
    ...createCrawlTools(config),
    ...createBatchScrapeTools(config),
    ...createMapSearchTools(config),
    ...createExtractTools(config),
    ...createFireAgentTools(config),
    ...createUsageTools(config),
    ...createParseTools(config),
    ...createBrowserTools(config),
    ...createMonitorTools(config),
  ];
}

function createFirecrawlToolByName(
  config: FirecrawlToolsConfig,
  name: string,
): AgentTool[] {
  return createFirecrawlTools(config).filter(
    (tool) => tool.definition.name === name,
  );
}

export const FIRECRAWL_HUB_TOOLS = Object.fromEntries(
  FIRECRAWL_DEFINITIONS.map((definition) => [
    definition.name,
    {
      definition,
      providerName: "firecrawl" as const,
      createTools: (config: {
        apiKey: string;
        baseURL?: string;
        fetcher?: FirecrawlToolsConfig["fetcher"];
      }) =>
        // Firecrawl's base URL is owned by the package (FIRECRAWL_DEFAULT_BASE_URL),
        // not configured per credential. The hub forwards the provider row's
        // optional, free-text baseURL, which may be empty or malformed; ignoring
        // it here keeps a bad provider value from breaking every Firecrawl tool.
        createFirecrawlToolByName(
          {
            apiKey: config.apiKey,
            ...(config.fetcher ? { fetcher: config.fetcher } : {}),
          },
          definition.name,
        ),
    },
  ]),
);
