import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type ExaFetch = (input: string, init: RequestInit) => Promise<Response>;

const ExaToolsConfig = type({
  apiKey: "string",
  "baseUrl?": "string",
  "fetcher?": "unknown",
});

export type ExaToolsConfig = typeof ExaToolsConfig.infer & {
  fetcher?: ExaFetch;
};

const ExaSearchResult = type({
  "title?": "string",
  "url?": "string",
  "publishedDate?": "string",
  "author?": "string",
  "text?": "string",
  "summary?": "string",
});

type ExaSearchResult = typeof ExaSearchResult.infer;

const ExaSearchResponse = type({
  results: ExaSearchResult.array(),
});

type ExaSearchResponse = typeof ExaSearchResponse.infer;

const WebResearchItem = type({
  url: "string",
  title: "string",
  publishedAt: "string",
  source: '"web"',
  engagement: { upvotes: "number", comments: "number" },
  "author?": "string",
  "provenance?": '"degraded"',
});

type WebResearchItem = typeof WebResearchItem.infer;

const SearchArgs = type({
  query: "string > 0",
  "numResults?": "number",
  "type?": "string",
  "includeDomains?": "unknown",
  "excludeDomains?": "unknown",
});

const StringArray = type("string[]");

// Web results carry no engagement signal and often no publish date. Rather than
// force the agent to reshape Exa output before last30days_core_report (the "exa
// vs web" friction), emit ResearchItems directly: zero engagement, and when the
// page has no date fall back to retrieval time tagged `degraded` so it stays in
// the window but ranks below dated, voted sources instead of being dropped.
function normalizeExaResult(
  result: ExaSearchResult,
  retrievedAt: string,
): WebResearchItem | null {
  const url = result.url ?? "";
  if (url.length === 0) {
    return null;
  }
  const item: WebResearchItem = {
    url,
    title: result.title ?? "",
    publishedAt: result.publishedDate ?? retrievedAt,
    source: "web",
    engagement: { upvotes: 0, comments: 0 },
  };
  if (result.author !== undefined) {
    item.author = result.author;
  }
  if (result.publishedDate === undefined) {
    item.provenance = "degraded";
  }
  return item;
}

const DEFAULT_BASE_URL = "https://api.exa.ai";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 25;

function exaHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSearchResponse(value: unknown): ExaSearchResponse {
  const parsed = ExaSearchResponse(value);
  if (parsed instanceof type.errors) {
    throw new Error("Exa response contains an invalid search result list");
  }
  return parsed;
}

function validateConfig(config: ExaToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Exa apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Exa baseUrl must be a valid URL");
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

async function fetchExaJSON(
  config: ExaToolsConfig,
  url: URL,
  body: unknown,
  signal: AbortSignal,
) {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    method: "POST",
    headers: exaHeaders(config.apiKey),
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(
      await response.text().catch(() => ""),
    );
    const detail = response.statusText || bodyText;
    throw new Error(`Exa API error: ${response.status} ${detail ?? ""}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function searchExa(
  config: ExaToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`query is required`);
  }

  const numResults = Math.min(
    parsed.numResults !== undefined &&
      Number.isInteger(parsed.numResults) &&
      parsed.numResults > 0
      ? parsed.numResults
      : DEFAULT_NUM_RESULTS,
    MAX_NUM_RESULTS,
  );

  const url = new URL(
    `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}/search`,
  );

  const body: Record<string, unknown> = {
    query: parsed.query,
    numResults,
  };

  if (parsed.type !== undefined) {
    body.type = parsed.type;
  }
  const includeDomains = StringArray(parsed.includeDomains);
  if (!(includeDomains instanceof type.errors)) {
    body.includeDomains = includeDomains;
  }
  const excludeDomains = StringArray(parsed.excludeDomains);
  if (!(excludeDomains instanceof type.errors)) {
    body.excludeDomains = excludeDomains;
  }

  const response = parseSearchResponse(
    await fetchExaJSON(config, url, body, signal),
  );
  const retrievedAt = new Date().toISOString();
  return response.results
    .map((result) => normalizeExaResult(result, retrievedAt))
    .filter((item): item is WebResearchItem => item !== null);
}

const WEB_SEARCH_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "The search query string.",
    },
    numResults: {
      type: "number",
      description: "Maximum number of results to return (1-25, default 5).",
    },
    type: {
      type: "string",
      description:
        "Search depth: auto, instant, neural, fast, deep. Optional, default auto.",
    },
    includeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Optional list of domains to include.",
    },
    excludeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Optional list of domains to exclude.",
    },
  },
  required: ["query"],
};

const RESULT_SHAPE_NOTE =
  'Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "web", author?, engagement: { upvotes: 0, comments: 0 } }`. When a result has no real publish date, publishedAt falls back to fetch time and provenance is "degraded". Ready to pass straight into last30days_core_report.';

export const EXA_SEARCH_DEFINITION: ToolDefinition = {
  name: "exa_search",
  description: `Search the web. Use this to find current information, research topics, or verify facts. ${RESULT_SHAPE_NOTE}`,
  inputSchema: WEB_SEARCH_INPUT_SCHEMA,
};

// web_search is the generic, provider-agnostic name for the same capability so the
// agent does not have to reason about "exa vs web"; both names resolve to the same
// handler and normalized output.
export const WEB_SEARCH_DEFINITION: ToolDefinition = {
  name: "web_search",
  description: `General web search. Pass a query; provider selection is handled server-side. ${RESULT_SHAPE_NOTE}`,
  inputSchema: WEB_SEARCH_INPUT_SCHEMA,
};

function buildExaHandler(config: ExaToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await searchExa(config, args, signal));
}

export function createExaTools(config: ExaToolsConfig): AgentTool[] {
  validateConfig(config);
  const handler = buildExaHandler(config);

  return [
    { kind: "string", definition: EXA_SEARCH_DEFINITION, handler },
    { kind: "string", definition: WEB_SEARCH_DEFINITION, handler },
  ];
}

function createExaToolFor(
  config: ExaToolsConfig,
  definition: ToolDefinition,
): AgentTool[] {
  validateConfig(config);
  return [{ kind: "string", definition, handler: buildExaHandler(config) }];
}

/**
 * Hub tool registry entries for exa. Each entry declares the tool definition,
 * the Interchange provider name for credential resolution, and a factory that
 * returns the AgentTool handlers given resolved credentials.
 *
 * Import and spread into the hub's KNOWN_TOOLS to register. No hub logic changes
 * are needed when new entries are added here.
 */
export const EXA_HUB_TOOLS = {
  exa_search: {
    definition: EXA_SEARCH_DEFINITION,
    providerName: "exa" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createExaToolFor({ apiKey: config.apiKey }, EXA_SEARCH_DEFINITION),
  },
  web_search: {
    definition: WEB_SEARCH_DEFINITION,
    providerName: "exa" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createExaToolFor({ apiKey: config.apiKey }, WEB_SEARCH_DEFINITION),
  },
};
