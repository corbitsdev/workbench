/**
 * Shared primitives for the Firecrawl tool package.
 *
 * Every feature module (scrape, crawl, batch-scrape, map-search, extract,
 * fire-agent, browser, monitor, usage) imports from here. The contract in this
 * file is stable: config types, a generic HTTP helper that covers every
 * Firecrawl endpoint, and argument/response parsing utilities.
 */
import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type FirecrawlFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * Firecrawl's API base URL (v2). Owned by the tool package so callers only need
 * to supply an API key — the base URL is pulled in here rather than stored per
 * credential. Override is still possible via `baseUrl`.
 */
export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev/v2";

const FirecrawlToolsConfigSchema = type({
  apiKey: "string",
  "baseUrl?": "string",
});

export type FirecrawlToolsConfig = typeof FirecrawlToolsConfigSchema.infer & {
  fetcher?: FirecrawlFetch;
};

const ResolvedFirecrawlConfigSchema = type({
  apiKey: "string",
  baseUrl: "string",
});

export type ResolvedFirecrawlConfig =
  typeof ResolvedFirecrawlConfigSchema.infer & {
    fetcher?: FirecrawlFetch;
  };

/**
 * Resolve a caller-supplied config into one with a concrete base URL, then
 * validate it. Every `create<Area>Tools` factory calls this first so each
 * module is independently usable and testable.
 */
export function resolveConfig(
  config: FirecrawlToolsConfig,
): ResolvedFirecrawlConfig {
  const resolved: ResolvedFirecrawlConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl?.trim() || FIRECRAWL_DEFAULT_BASE_URL,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  };
  validateConfig(resolved);
  return resolved;
}

function validateConfig(config: ResolvedFirecrawlConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Firecrawl apiKey is required");
  }
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error("Firecrawl baseUrl must be a valid URL");
  }
}

function firecrawlHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/** Pretty-printed JSON, the standard string-tool result shape in this repo. */
export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Build an AgentTool whose handler returns the JSON-stringified call result. */
export function stringTool(
  definition: ToolDefinition,
  call: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
): AgentTool {
  return {
    kind: "string",
    definition,
    handler: async (args, signal) => jsonResult(await call(args, signal)),
  };
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type FirecrawlRequest = {
  method: HttpMethod;
  /** Path appended to the base URL, beginning with `/` (e.g. `/scrape`). */
  path: string;
  /** Query string params; `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined> | undefined;
  /** JSON request body for POST/PUT. Omit for GET/DELETE. */
  body?: unknown;
};

/**
 * Single HTTP entry point for every Firecrawl endpoint. Resolves the URL +
 * query, sets the bearer auth header, and surfaces non-2xx responses as a
 * `Firecrawl API error: <status> <detail>` throw (detail prefers the API's
 * error/message body field). Returns the parsed JSON body as `unknown`.
 */
export async function firecrawlFetchJSON(
  config: ResolvedFirecrawlConfig,
  request: FirecrawlRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}${request.path}`);
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    method: request.method,
    headers: firecrawlHeaders(config.apiKey),
    signal,
    ...(request.body !== undefined
      ? { body: JSON.stringify(request.body) }
      : {}),
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ""));
    const detail = response.statusText || body;
    throw new Error(`Firecrawl API error: ${response.status} ${detail ?? ""}`);
  }

  return (await response.json()) as unknown;
}

export function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    }
  } catch {
    return text;
  }
  return text;
}

// --- Argument / response parsing helpers ------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate tool args at the trust boundary using an arktype schema. */
export function parseArgs<T>(
  schema: { (input: unknown): T | type.errors },
  args: unknown,
  toolName: string,
): T {
  const parsed = schema(args);
  if (parsed instanceof type.errors) {
    throw new Error(`${toolName}: ${parsed.summary}`);
  }
  return parsed;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

export function optionalStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return value;
}

/** A nested object argument (e.g. `scrapeOptions`, `jsonOptions`), passed through as-is. */
export function optionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function requiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function requiredStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = optionalStringArray(args[key]);
  if (value === null || value.length === 0) {
    throw new Error(
      `${key} is required and must be a non-empty array of strings`,
    );
  }
  return value;
}

// --- Arktype schemas for tool arg boundaries --------------------------------

export const ScrapeArgsSchema = type({
  url: "string > 0",
  "formats?": "string[]",
  "onlyMainContent?": "boolean",
  "includeTags?": "string[]",
  "excludeTags?": "string[]",
  "waitFor?": "number",
  "timeout?": "number",
  "jsonOptions?": "Record<string, unknown>",
});

export type ScrapeArgs = typeof ScrapeArgsSchema.infer;

export const RequiredIdArgsSchema = type({ id: "string > 0" });
export type RequiredIdArgs = typeof RequiredIdArgsSchema.infer;

export const CrawlStartArgsSchema = type({
  url: "string > 0",
  "limit?": "number",
  "maxDepth?": "number",
  "includePaths?": "string[]",
  "excludePaths?": "string[]",
  "allowBackwardLinks?": "boolean",
  "scrapeOptions?": "Record<string, unknown>",
});

export type CrawlStartArgs = typeof CrawlStartArgsSchema.infer;

export const CrawlParamsPreviewArgsSchema = type({
  url: "string > 0",
  prompt: "string > 0",
});

export type CrawlParamsPreviewArgs = typeof CrawlParamsPreviewArgsSchema.infer;

export const BatchScrapeStartArgsSchema = type({
  urls: "string[] >= 1",
  "scrapeOptions?": "Record<string, unknown>",
});

export type BatchScrapeStartArgs = typeof BatchScrapeStartArgsSchema.infer;

export const MapArgsSchema = type({
  url: "string > 0",
  "search?": "string > 0",
  "limit?": "number",
  "includeSubdomains?": "boolean",
  "sitemapOnly?": "boolean",
});

export type MapArgs = typeof MapArgsSchema.infer;

export const SearchArgsSchema = type({
  query: "string > 0",
  "limit?": "number",
  "sources?": "string[]",
  "tbs?": "string > 0",
  "scrapeOptions?": "Record<string, unknown>",
});

export type SearchArgs = typeof SearchArgsSchema.infer;

export const ExtractStartArgsSchema = type({
  urls: "string[] >= 1",
  "prompt?": "string",
  "schema?": "Record<string, unknown>",
  "enableWebSearch?": "boolean",
});

export type ExtractStartArgs = typeof ExtractStartArgsSchema.infer;

export const FireAgentArgsSchema = type({
  prompt: "string > 0",
  "schema?": "Record<string, unknown>",
});

export type FireAgentArgs = typeof FireAgentArgsSchema.infer;

export const InteractArgsSchema = type({
  jobId: "string > 0",
  "code?": "string > 0",
  "prompt?": "string > 0",
  "language?": "string > 0",
  "timeout?": "number",
});

export type InteractArgs = typeof InteractArgsSchema.infer;

export const ParseArgsSchema = type({
  url: "string > 0",
  "options?": "Record<string, unknown>",
});

export type ParseArgs = typeof ParseArgsSchema.infer;

export const MonitorCreateArgsSchema = type({
  config: "Record<string, unknown>",
});

export type MonitorCreateArgs = typeof MonitorCreateArgsSchema.infer;

export const MonitorUpdateArgsSchema = type({
  id: "string > 0",
  config: "Record<string, unknown>",
});

export type MonitorUpdateArgs = typeof MonitorUpdateArgsSchema.infer;

export const HistoricalCreditUsageArgsSchema = type({
  "byApiKey?": "boolean",
});

export type HistoricalCreditUsageArgs =
  typeof HistoricalCreditUsageArgsSchema.infer;

export const ActivityArgsSchema = type({
  "endpoint?": "string",
  "limit?": "number",
  "cursor?": "string",
});

export type ActivityArgs = typeof ActivityArgsSchema.infer;
