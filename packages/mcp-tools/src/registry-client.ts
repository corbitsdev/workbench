// Lists the MCP servers this tenant has connected, via the same
// workflow-run-authenticated connections surface
// `@corbits/connections-tools`' `client.ts` calls for `list_connections`
// (`@workbench/connections`'s `createWorkflowConnectionRoutes`, mounted
// in `apps/hub` at `/api/workflow-connections`). This is a SEPARATE
// endpoint (`/mcp-servers`) from the generic `/connections` one that
// route exposes: an MCP server is a tenant-created, dynamically-slugged
// connector (`mcp:<slug>`), not a fixed entry in `CONNECTOR_REGISTRY`,
// so listing it needs its own shape (slug + the server's own URL, not a
// registry displayName).
import { type } from "arktype";

export interface McpRegistryClientConfig {
  /** The hub's plain HTTP origin — same value `hubConnectionsUrl` names
   * for `@corbits/connections-tools`. */
  readonly hubConnectionsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface McpServerListing {
  /** The `mcp:<slug>` credential handle's slug half — what
   * `mcp_list_tools`/`mcp_call` take as their `server` argument. */
  readonly slug: string;
  /** The human-supplied name shown in Plugins. */
  readonly name: string;
  /** The server's Streamable HTTP endpoint URL. */
  readonly url: string;
}

const McpServersResponse = type({
  data: type({
    slug: "string",
    name: "string",
    url: "string",
  }).array(),
});

function authHeaders(config: McpRegistryClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Fetches every MCP server this tenant currently has connected. Throws
 * on any transport, HTTP, or shape failure — the calling tool degrades
 * that into an honest "not connected" result, never a fabricated
 * empty list. */
export async function listMcpServers(
  config: McpRegistryClientConfig,
): Promise<readonly McpServerListing[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubConnectionsUrl}/api/workflow-connections/mcp-servers`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(
      `Fetching MCP servers failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = McpServersResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `MCP servers response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}
