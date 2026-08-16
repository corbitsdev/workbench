// The MCP-server connector's own "probe": not a single authenticated GET
// (the api-key connectors' `probes.ts` shape) but a real MCP handshake —
// `initialize` then `tools/list` — over the URL a person just pasted into
// Plugins. Reuses `@corbits/mcp-tools`' own client wrapper rather than a
// second hand-rolled MCP client: the exact transport/session mechanics
// `mcp_list_tools` uses at call time, run once at connect time to prove
// the URL is a real MCP server before it is ever stored.
import { withMcpConnection, listMcpTools } from "@corbits/mcp-tools";

export type McpProbeResult =
  | { readonly ok: true; readonly toolCount: number }
  | { readonly ok: false; readonly message: string };

/** Builds the bearer-authenticated fetch the probe (and nothing durable)
 * uses: a plain `fetch` injecting `authorization` when a token was
 * pasted, with no origin pinning — this is the one-shot pre-storage
 * check, before a provider row (and its pinned origin) exists at all. */
function probeFetch(token: string | undefined): typeof fetch {
  if (token === undefined || token.length === 0) return fetch;
  return ((input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input as string | URL, { ...init, headers });
  }) as typeof fetch;
}

/** Proves `url` is a reachable Streamable HTTP MCP server: connect,
 * `initialize`, `tools/list`, disconnect. Never throws — every failure
 * (bad URL, network error, non-MCP endpoint, a rejected token) degrades
 * to `{ ok: false, message }`, mirroring every other connector probe in
 * this package. */
export async function probeMcpServer(
  url: string,
  token: string | undefined,
): Promise<McpProbeResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, message: `"${url}" is not a valid URL.` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, message: "The MCP server URL must be http or https." };
  }

  try {
    const tools = await withMcpConnection(
      { url, fetchImpl: probeFetch(token) },
      (client) => listMcpTools(client),
    );
    return { ok: true, toolCount: tools.length };
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not connect to that MCP server: ${cause.message}`
          : `Could not connect to that MCP server: ${String(cause)}`,
    };
  }
}
