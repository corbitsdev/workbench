// The MCP-server connector's own "probe": not a single authenticated GET
// (the api-key connectors' `probes.ts` shape) but a real MCP handshake —
// `initialize` then `tools/list` — over the URL a person just pasted into
// Plugins. Reuses `@corbits/mcp-tools`' own client wrapper rather than a
// second hand-rolled MCP client: the exact transport/session mechanics
// `mcp_list_tools` uses at call time, run once at connect time to prove
// the URL is a real MCP server before it is ever stored.
import { mcpOriginPinnedFetch } from "@corbits/credential-providers";
import { withMcpConnection, listMcpTools } from "@corbits/mcp-tools";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { reportError } from "@corbits/error-sink";

export type McpProbeResult =
  | { readonly ok: true; readonly toolCount: number }
  | {
      readonly ok: false;
      readonly message: string;
      readonly requiresOAuth?: false;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly requiresOAuth: true;
      readonly authorizationServerUrl: string;
    };

/** True for the message shape the SDK's fetch-based transport throws when
 * the server answers 401/403 to the initial request -- the only signal
 * available before any MCP-level response body exists to inspect. */
function looksUnauthorized(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b401\b|\b403\b|unauthorized|forbidden/i.test(message);
}

/** Runs the official SDK's RFC 9728 discovery against a server that just
 * answered 401 -- if it advertises a real authorization server metadata
 * document, this is an OAuth-gated MCP server per the MCP authorization
 * spec, not a broken URL or a plain rejected token. `discoverOAuthServerInfo`
 * always returns *some* `authorizationServerUrl` (it falls back to the MCP
 * server's own origin when RFC 9728/8414 discovery finds nothing), so this
 * only reports `requiresOAuth` when real `authorizationServerMetadata` was
 * actually found -- otherwise every plain 401 would misreport as OAuth. */
async function discoverOAuthRequirement(
  url: string,
): Promise<{ authorizationServerUrl: string } | undefined> {
  try {
    const info = await discoverOAuthServerInfo(url);
    return info.authorizationServerMetadata !== undefined
      ? { authorizationServerUrl: info.authorizationServerUrl }
      : undefined;
  } catch (cause) {
    // A missing discovery document is the expected negative result (most
    // MCP servers aren't OAuth-gated) and degrades to it identically to a
    // real discovery-transport failure — report so an actual outage here
    // doesn't silently read as "this server doesn't do OAuth."
    reportError(cause, {
      operation: "discover_mcp_oauth_requirement",
      extra: { origin: new URL(url).origin },
    });
    return undefined;
  }
}

/** Builds the origin-pinned fetch the probe (and nothing durable) uses:
 * the same helper `mcp_call` later uses via the credential provider, pinned
 * to this server's origin so a 3xx cannot leak a bearer (or a keyless
 * handshake) off the URL the person pasted. Keyless probes pin too. */
function probeFetch(url: string, token: string | undefined): typeof fetch {
  const pinnedOrigin = new URL(url).origin;
  return mcpOriginPinnedFetch({
    pinnedOrigin,
    readToken: () =>
      token === undefined || token.length === 0 ? undefined : token,
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
    // report-error-ignore: CL-7247 — a malformed URL here is a person's
    // paste-in typo (the same "not a valid URL" outcome the UI already
    // surfaces to them), never a system fault; there is nothing to fix in
    // response to it.
    return { ok: false, message: `"${url}" is not a valid URL.` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, message: "The MCP server URL must be http or https." };
  }

  try {
    const tools = await withMcpConnection(
      { url, fetchImpl: probeFetch(url, token) },
      (client) => listMcpTools(client),
    );
    return { ok: true, toolCount: tools.length };
  } catch (cause) {
    const message =
      cause instanceof Error
        ? `Could not connect to that MCP server: ${cause.message}`
        : `Could not connect to that MCP server: ${String(cause)}`;
    reportError(cause, {
      operation: "probe_mcp_server",
      extra: { origin: parsedUrl.origin },
    });
    if (looksUnauthorized(cause)) {
      const discovered = await discoverOAuthRequirement(url);
      if (discovered !== undefined) {
        return {
          ok: false,
          message:
            "This MCP server requires signing in via OAuth before it can be connected.",
          requiresOAuth: true,
          authorizationServerUrl: discovered.authorizationServerUrl,
        };
      }
    }
    return { ok: false, message };
  }
}
