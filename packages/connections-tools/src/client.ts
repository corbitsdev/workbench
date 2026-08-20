// A minimal client for the workflow-run-authenticated connections
// surface a running agent calls to see which third-party connectors
// this workbench already has live — the execution half of
// `@workbench/connections`'s `createWorkflowConnectionRoutes`
// (`packages/connections/src/workflow-connection-routes.ts`), mounted
// in `apps/hub` at `/api/workflow-connections` beside
// `/api/workflow-capabilities` and `/api/workflow-skills` —
// authenticated the same way, via a `WorkflowRunAuthenticator` (sidecar
// bearer token + run address), never a human browser session.
import { type } from "arktype";

export interface ConnectionsToolClientConfig {
  /** The hub's plain HTTP origin — same value capability-tools'
   * `hubCapabilitiesUrl` and memory-tools' `hubMemoryUrl` reach the hub
   * through. */
  readonly hubConnectionsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type ConnectionStatus = {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly connected: boolean;
};

const ConnectionsResponse = type({
  data: type({
    id: "string",
    displayName: "string",
    docsUrl: "string",
    connected: "boolean",
  }).array(),
});

function authHeaders(
  config: ConnectionsToolClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Fetches every connector this workbench knows about, each flagged
 * with whether the calling tenant currently has a live credential for
 * it. Throws on any transport, HTTP, or shape failure — never
 * fabricates a result. */
export async function listConnections(
  config: ConnectionsToolClientConfig,
): Promise<readonly ConnectionStatus[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubConnectionsUrl}/api/workflow-connections/connections`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(
      `Fetching connections failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = ConnectionsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Connections response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Thrown when the caller's run has no room of its own to post into —
 * the workflow-participant route's "not a participant of any channel"
 * 404. `request_connection` degrades to a plain deep link then. */
export class NoOwnRoomError extends Error {}

const PostedMessageResponse = type({ id: "string", createdAt: "string" });

export type ConnectServiceCard = {
  readonly connectorId: string;
  readonly displayName: string;
  readonly reason: string;
};

/** Posts a `connect-service` block into the caller's own room through
 * the same workflow-run-authenticated `participants/messages` route
 * `@corbits/interaction-tools`' `ask_user` posts its question blocks
 * to. The card carries framing only; the room's client resolves the
 * live connect state when it renders. */
export async function postConnectServiceBlock(
  config: ConnectionsToolClientConfig,
  card: ConnectServiceCard,
): Promise<{ readonly messageId: string }> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubConnectionsUrl}/api/workflow-chat/participants/messages`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-service",
              data: {
                connectorId: card.connectorId,
                displayName: card.displayName,
                reason: card.reason,
              },
            },
          },
        ],
      }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnRoomError("The caller has no room of its own to post into");
  }
  if (!response.ok) {
    throw new Error(
      `Posting the connect card failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = PostedMessageResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Post-message response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return { messageId: parsed.id };
}

export type McpServerConnectionStatus = {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
};

const McpServersResponse = type({
  data: type({
    slug: "string",
    name: "string",
    url: "string",
  }).array(),
});

/** Fetches every MCP server this tenant has connected through Plugins —
 * the same `/api/workflow-connections/mcp-servers` route
 * `@corbits/mcp-tools`' `mcp_list_servers` reads, reused here rather
 * than a second listing mechanism, so `list_connections` reports the
 * same connected set an agent would see calling `mcp_list_servers`
 * directly. Throws on any transport, HTTP, or shape failure. */
export async function listMcpServerConnections(
  config: ConnectionsToolClientConfig,
): Promise<readonly McpServerConnectionStatus[]> {
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
