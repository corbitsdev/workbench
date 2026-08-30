// Shared origin pin for MCP Streamable HTTP: the credential provider and
// the connect-time probe must refuse the same cross-origin first hops and
// never follow a 3xx (even to an allowlisted origin). Extra origins are
// an explicit map keyed by the pinned origin — not a host suffix.

import type { FetchLike } from "./http-x-api-key-provider";

/**
 * Additional first-hop origins a pinned MCP credential may call. Only
 * `https://mcp.canva.com` → `https://canva.ai`: Canva's MCP protocol
 * origin is not the stored `apiBaseUrl` origin.
 */
const MCP_PINNED_ORIGIN_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  "https://mcp.canva.com": ["https://canva.ai"],
};

export interface McpOriginPinnedFetchArgs {
  /** Origin the handle is pinned to (`new URL(context.origin).origin`). */
  pinnedOrigin: string;
  /** Injectable `fetch`; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Secret for this request. Called per fetch so a rotation reaches the
   * handle without a rebuild. `undefined` or empty omits `authorization`
   * (keyless / sentinel already translated by the caller).
   */
  readToken: () => string | undefined;
}

/**
 * Resolve the URL a request targets: a relative string resolves against
 * the pinned origin, an absolute string or URL keeps its own origin, and
 * a `Request` already carries an absolute URL.
 */
export function resolveMcpTargetUrl(
  input: string | URL | Request,
  pinnedOrigin: string,
): URL {
  if (typeof input === "string") {
    return new URL(input, pinnedOrigin);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

/**
 * Throw if `target` is neither the pinned origin nor an explicit extra
 * origin for that pin. Error text matches the mcp-streamable-http
 * provider's historical refusal.
 */
export function assertMcpPinnedTarget(target: URL, pinnedOrigin: string): void {
  if (target.origin === pinnedOrigin) return;
  const extras = MCP_PINNED_ORIGIN_EXTRAS[pinnedOrigin];
  if (extras !== undefined && extras.includes(target.origin)) return;
  throw new Error(
    `mcp-streamable-http credential is pinned to ${pinnedOrigin}; refusing cross-origin request to ${target.origin}`,
  );
}

function applyAuthorization(headers: Headers, token: string | undefined): void {
  if (token === undefined || token.length === 0) {
    headers.delete("authorization");
    return;
  }
  headers.set("authorization", `Bearer ${token}`);
}

/**
 * Fetch that origin-checks every request, injects Bearer when a token is
 * present, and forces `redirect: "manual"` so a 3xx never sends a token
 * (or a keyless handshake) to a foreign host.
 */
export function mcpOriginPinnedFetch(
  args: McpOriginPinnedFetchArgs,
): FetchLike {
  const fetchImpl: FetchLike = args.fetch ?? globalThis.fetch;

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const target = resolveMcpTargetUrl(input, args.pinnedOrigin);
    assertMcpPinnedTarget(target, args.pinnedOrigin);
    const token = args.readToken();

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      applyAuthorization(headers, token);
      return fetchImpl(new Request(input, { headers, redirect: "manual" }));
    }

    const headers = new Headers(init?.headers);
    applyAuthorization(headers, token);
    return fetchImpl(target, { ...init, headers, redirect: "manual" });
  };
}
