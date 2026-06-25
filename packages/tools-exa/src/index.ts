import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type ExaFetch = (input: string, init: RequestInit) => Promise<Response>;

export type ExaToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: ExaFetch;
};

type ExaSearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  summary?: string;
};

type ExaSearchResponse = {
  results: ExaSearchResult[];
};

// Structurally compatible with @workbench/last30days-core ResearchItem (source 'web').
// Kept as a local literal type so tools-exa stays dependency-free, matching the
// other source packages (reddit/hackernews normalize inline rather than importing).
type WebResearchItem = {
  url: string;
  title: string;
  publishedAt: string;
  source: "web";
  engagement: { upvotes: number; comments: number };
  author?: string;
  provenance?: "degraded";
};

// Web results carry no engagement signal and often no publish date. Rather than
// force the agent to reshape Exa output before last30days_core_report (the "exa
// vs web" friction), emit ResearchItems directly: zero engagement, and when the
// page has no date fall back to retrieval time tagged `degraded` so it stays in
// the window but ranks below dated, voted sources instead of being dropped.
function normalizeExaResult(
  result: ExaSearchResult,
  retrievedAt: string,
): WebResearchItem | null {
  if (result.url.length === 0) {
    return null;
  }
  const item: WebResearchItem = {
    url: result.url,
    title: result.title,
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSearchResult(value: unknown): ExaSearchResult {
  if (!isRecord(value)) {
    throw new Error("Exa response contains an invalid search result");
  }

  const title = typeof value.title === "string" ? value.title : "";
  const url = typeof value.url === "string" ? value.url : "";
  const publishedDate = optionalString(value.publishedDate);
  const author = optionalString(value.author);
  const text = optionalString(value.text);
  const summary = optionalString(value.summary);

  return {
    title,
    url,
    ...(publishedDate !== null ? { publishedDate } : {}),
    ...(author !== null ? { author } : {}),
    ...(text !== null ? { text } : {}),
    ...(summary !== null ? { summary } : {}),
  };
}

function parseSearchResponse(value: unknown): ExaSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("Exa response contains an invalid search result list");
  }

  return {
    results: value.results.map(parseSearchResult),
  };
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
  const query = optionalString(args.query);
  if (query === null) {
    throw new Error("query is required");
  }

  const numResults = optionalPositiveInteger(
    args.numResults,
    DEFAULT_NUM_RESULTS,
    MAX_NUM_RESULTS,
  );
  const type = optionalString(args.type);
  const includeDomains = optionalStringArray(args.includeDomains);
  const excludeDomains = optionalStringArray(args.excludeDomains);

  const url = new URL(
    `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}/search`,
  );

  const body: Record<string, unknown> = {
    query,
    numResults,
  };

  if (type !== null) {
    body.type = type;
  }
  if (includeDomains !== null) {
    body.includeDomains = includeDomains;
  }
  if (excludeDomains !== null) {
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
