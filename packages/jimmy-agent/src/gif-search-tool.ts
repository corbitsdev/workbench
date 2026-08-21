// The `gif_search` tool: Jimmy's one capability. Ported from
// `scout/packages/jimmy`'s `giphy-search.ts` — the Giphy HTTP client and
// response parsing are carried over near-verbatim; the Slack picker,
// shuffle/cancel signal machine, and block-kit rendering are NOT ported
// (see this package's README). A missing credential degrades to a
// "connect Giphy" error result, never a thrown error and never a silent
// empty reply — same contract as `@corbits/web-search-tools` and
// `@corbits/granola-tools`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import { GIF_SEARCH_TOOL } from "./metadata";

/** `defineTool` requires a namespaced id; the agent-facing call name stays `gif_search`. */
const GIF_SEARCH_TOOL_ID = "@corbits/jimmy-agent/gif-search";

/** The handle this package declares in `interchange.credentials`. */
const GIPHY_CREDENTIAL_HANDLE = "giphy";

const GIPHY_API_HOST = "https://api.giphy.com";
const DEFAULT_RATING = "pg-13";
const DEFAULT_LANG = "en";
const DEFAULT_LIMIT = 1;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5;

export interface GifResult {
  title: string;
  cdnUrl: string;
  pageUrl?: string;
}

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential capability. */
export interface GifSearchEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

/** The wire shape `@corbits/connections`' `missingCredentialDetail` defines
 * (`{kind: "missing-credential", connectorId}`) — reproduced here rather
 * than imported, per that module's own doc comment: any tool package can
 * write this shape onto a `ToolResult` with no dependency on the
 * `connections` package, since only the chat orchestrator's reader needs
 * to parse it. `@corbits/github-tools`' `pull-request-tools.ts` follows
 * the same convention. This is what turns the plain error message below
 * into a real "Connect Giphy" button in chat instead of a dead end. */
function missingCredentialDetail(connectorId: string) {
  return { kind: "missing-credential", connectorId } as const;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content:
      "Connect Giphy to let Jimmy search for GIFs — this workspace has no Giphy credential yet.",
    isError: true,
    detail: missingCredentialDetail(GIPHY_CREDENTIAL_HANDLE),
  };
}

/**
 * Resolve this bundle's mediated Giphy credential, or `null` when it is
 * not connected — an absent `env.credentials`, an unbound handle, or a
 * denied grant all collapse to the same "not connected" signal.
 */
async function resolveGiphyCredential(
  env: GifSearchEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(GIPHY_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

function isAllowedGiphyHostURL(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return u.hostname === "giphy.com" || u.hostname.endsWith(".giphy.com");
  } catch {
    return false;
  }
}

const MAX_TITLE_LENGTH = 120;

/** Neutralize attacker-influenced titles before they reach a chat reply. */
function sanitizeGifTitle(raw: string): string {
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

const GiphyRendition = type({ "url?": "string" });

const GiphyItem = type({
  "title?": "string",
  "url?": "string",
  "images?": {
    "original?": GiphyRendition,
    "downsized?": GiphyRendition,
    "downsized_medium?": GiphyRendition,
    "fixed_height?": GiphyRendition,
  },
});
type GiphyItem = typeof GiphyItem.infer;

const GiphyEnvelope = type({
  "data?": "unknown",
  "meta?": { "status?": "number", "msg?": "string" },
});

function pickCdnUrl(item: GiphyItem): string | undefined {
  const renditions = [
    item.images?.original,
    item.images?.downsized,
    item.images?.downsized_medium,
    item.images?.fixed_height,
  ];
  for (const rendition of renditions) {
    const url = rendition?.url?.trim();
    if (url !== undefined && url !== "" && isAllowedGiphyHostURL(url))
      return url;
  }
  return undefined;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < MIN_LIMIT) return MIN_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * Search Giphy through the mediated fetch bound to the "giphy" handle.
 * The mediated fetch is responsible for authenticating the request (the
 * tool never sees the raw key) — see this package's README for the one
 * follow-up this depends on: a connector registration whose credential
 * plugin can place the key on the query string Giphy's search endpoint
 * requires.
 */
async function searchGiphy(
  fetchImpl: typeof fetch,
  query: string,
  limit: number,
): Promise<GifResult[]> {
  const url = new URL(`${GIPHY_API_HOST}/v1/gifs/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("rating", DEFAULT_RATING);
  url.searchParams.set("lang", DEFAULT_LANG);

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Giphy search failed: ${String(response.status)} ${response.statusText}`,
    );
  }

  const raw: unknown = await response.json();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Giphy search failed: unexpected response shape");
  }
  const envelope = GiphyEnvelope(raw);
  if (envelope instanceof type.errors) {
    throw new Error(`Giphy search failed: ${envelope.summary}`);
  }
  const status = envelope.meta?.status;
  if (status !== undefined && status !== 200) {
    throw new Error(
      `Giphy rejected the request: ${envelope.meta?.msg ?? String(status)}`,
    );
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error("Giphy search failed: response has no data array");
  }

  const mapped: GifResult[] = [];
  for (const rawItem of envelope.data) {
    if (mapped.length >= limit) break;
    const item = GiphyItem(rawItem);
    if (item instanceof type.errors) continue;
    const cdnUrl = pickCdnUrl(item);
    if (cdnUrl === undefined) continue;
    const pageUrl = item.url?.trim();
    mapped.push({
      title: sanitizeGifTitle(item.title ?? ""),
      cdnUrl,
      ...(pageUrl !== undefined &&
      pageUrl !== "" &&
      isAllowedGiphyHostURL(pageUrl)
        ? { pageUrl }
        : {}),
    });
  }
  return mapped;
}

function formatResults(results: GifResult[]): string {
  if (results.length === 0) {
    return "No GIFs found for that query. Try different search terms.";
  }
  return results
    .map(
      (r, i) =>
        `[${String(i + 1)}] ${r.title || "untitled"}\nCDN: ${r.cdnUrl}` +
        (r.pageUrl !== undefined ? `\nPage: ${r.pageUrl}` : ""),
    )
    .join("\n\n");
}

async function runGifSearch(
  env: GifSearchEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveGiphyCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const query = call.arguments["query"];
  if (typeof query !== "string" || query.trim() === "") {
    return {
      callId: call.id,
      content: `${GIF_SEARCH_TOOL} requires a non-empty query argument`,
      isError: true,
    };
  }
  const limit = clampLimit(
    typeof call.arguments["limit"] === "number"
      ? (call.arguments["limit"] as number)
      : undefined,
  );
  try {
    const results = await searchGiphy(
      credential.fetchImpl,
      query.trim(),
      limit,
    );
    return { callId: call.id, content: formatResults(results) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/jimmy-agent` package's one tool: search Giphy and return
 * public CDN URLs. Never proxies media bytes; every GIF Jimmy surfaces
 * carries "Powered by GIPHY" per Giphy's terms (rendered by the chat UI,
 * not by this tool).
 */
export const gifSearchTool = defineTool<GifSearchEnv>({
  id: GIF_SEARCH_TOOL_ID,
  requires: [],
  definitions: [{ name: GIF_SEARCH_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: GIF_SEARCH_TOOL,
        description:
          "Search Giphy for a GIF and return a public CDN URL. Call with " +
          '{"query": "<search terms>", "limit": 1} — query is required, ' +
          "limit is optional (1-5, default 1). Reply with the returned " +
          "CDN URL(s); never download or re-host the media.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search terms for the GIF.",
            },
            limit: {
              type: "number",
              description: "How many GIF CDN URLs to return (1-5, default 1).",
            },
          },
          required: ["query"],
        },
      },
    ],
    run: (call, _signal) => runGifSearch(env, call),
  }),
});
