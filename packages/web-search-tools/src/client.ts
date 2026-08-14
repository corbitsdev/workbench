// A minimal Exa search client: one call, one normalized shape. Exa is the
// backend the OG gtm-workbench's last30days-research workflow actually
// called for its web-search source (`packages/tools-exa`) — ported as the
// same real integration rather than a placeholder, so this package's
// honesty holds the moment a tenant supplies a real key.
import { type } from "arktype";

const ExaSearchResult = type({
  "title?": "string",
  "url?": "string",
  "publishedDate?": "string",
  "author?": "string",
});
export type ExaSearchResult = typeof ExaSearchResult.infer;

const ExaSearchResponse = type({ results: ExaSearchResult.array() });

export interface WebSearchResult {
  readonly url: string;
  readonly title: string;
  /** ISO 8601. Falls back to fetch time when Exa reports no publish date. */
  readonly publishedAt: string;
  readonly source: "web";
  readonly author?: string;
  /** Set when publishedAt is a fallback, not a real publish date. */
  readonly provenance?: "degraded";
}

export interface WebSearchClientConfig {
  readonly apiKey: string;
  /** Override for tests; defaults to the real Exa API host. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.exa.ai";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 25;

function clampNumResults(requested: number | undefined): number {
  if (
    requested === undefined ||
    !Number.isInteger(requested) ||
    requested <= 0
  ) {
    return DEFAULT_NUM_RESULTS;
  }
  return Math.min(requested, MAX_NUM_RESULTS);
}

function normalizeResult(
  result: ExaSearchResult,
  retrievedAt: string,
): WebSearchResult | null {
  const url = result.url ?? "";
  if (url.length === 0) return null;
  const item: WebSearchResult = {
    url,
    title: result.title ?? "",
    publishedAt: result.publishedDate ?? retrievedAt,
    source: "web",
    ...(result.author !== undefined ? { author: result.author } : {}),
    ...(result.publishedDate === undefined ? { provenance: "degraded" } : {}),
  };
  return item;
}

/**
 * Searches the web via Exa. Throws on any transport, HTTP, or shape
 * failure — callers that need graceful degradation (e.g. this package's
 * `web_search` tool) catch at their own boundary.
 */
export async function searchWeb(
  config: WebSearchClientConfig,
  params: { readonly query: string; readonly numResults?: number },
): Promise<readonly WebSearchResult[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const url = new URL("/search", config.baseUrl ?? DEFAULT_BASE_URL);
  const response = await doFetch(url, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: params.query,
      numResults: clampNumResults(params.numResults),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Exa search request failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = ExaSearchResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Exa search response did not match the expected shape: ${parsed.summary}`,
    );
  }
  const retrievedAt = new Date().toISOString();
  return parsed.results
    .map((result) => normalizeResult(result, retrievedAt))
    .filter((item): item is WebSearchResult => item !== null);
}
