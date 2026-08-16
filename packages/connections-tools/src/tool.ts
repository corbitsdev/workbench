// The `@corbits/connections-tools` bundle: `list_connections` and
// `request_connection`, an agent's in-chat way to see which third-party
// connections (Attio, Exa, Granola, ...) this workbench already has
// live, and to hand the human a link to connect one that isn't yet.
// Both tools reuse the existing connections plane end to end
// (`@workbench/connections`'s `CONNECTOR_REGISTRY` and the workflow-run
// route it exposes) — neither invents new state, and neither completes
// OAuth itself; only a human, acting in the browser through the
// existing Connections settings surface, can finish a connect flow.
//
// Both tools also read `@workbench/connections`' MCP-server listing
// (CL-6142's `/api/workflow-connections/mcp-servers`, backed by
// `@corbits/mcp-tools`' own `mcp_list_servers` route) — a tenant-minted
// `mcp:<slug>` connector has no fixed registry id, so `list_connections`
// folds it into the connected list by name, and `request_connection`
// falls back to it (see `ADD_MCP_SERVER_DEEP_LINK`) before reporting an
// unknown connector.
//
// Approval: `list_connections` reads only, so it declares no `approval`
// key (matching a read-style tool, e.g. `@corbits/memory-tools`' search
// tool). `request_connection` performs no state-mutating HTTP call
// either — it reads the registry and the MCP-server listing and
// returns a deep-link string — so it also declares no `approval` key.
// Neither tool is architecturally required to gate behind a human:
// nothing here writes a credential, calls a third party, or exposes a
// secret. (Contrast `@corbits/capability-tools`' `request_capability`,
// which mutates a workflow definition and so genuinely needs
// `approval: "ask"`.)
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { CONNECTOR_REGISTRY } from "@workbench/connections";
import { type } from "arktype";

import { listConnections, listMcpServerConnections } from "./client";

export const LIST_CONNECTIONS_TOOL = "list_connections";
export const REQUEST_CONNECTION_TOOL = "request_connection";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach
 * credential, mirroring `@corbits/capability-tools`'
 * `WorkflowCapabilityEnv` (minus a `definitionId`, which
 * `request_connection` has no use for — it never mutates a
 * definition). */
export interface WorkflowConnectionEnv extends BaseEnv {
  readonly hubConnectionsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const RequestConnectionInput = type({
  connector: "string > 0",
});
type RequestConnectionInput = typeof RequestConnectionInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowConnectionEnv) {
  return {
    hubConnectionsUrl: env.hubConnectionsUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/** `/plugins?connect=<connectorId>` — a plain, honest deep link into
 * the Plugins panel.
 *
 * [Intx/repo gap]: this query param is not yet read by any apps/web
 * page. apps/web/src/shell/provider-health-context.tsx's
 * `requestPluginsConnect` sets `pendingConnectProvider` only via
 * in-app navigation calls (see apps/web/src/pages/chat-page.tsx's use
 * of it), never from a URL param — there is no URL-based deep link
 * today. So this link takes the human to the Plugins panel but does
 * not yet auto-open the specific connector; wiring `?connect=` up is a
 * small follow-up for whoever owns apps/web. */
function connectDeepLink(connectorId: string): string {
  return `/plugins?connect=${connectorId}`;
}

/** `/plugins?connect=mcp` — the same deep-link shape `connectDeepLink`
 * builds for a fixed `CONNECTOR_REGISTRY` id, pointed at Plugins'
 * generic "Add MCP server" card instead of one connector's own card,
 * since an MCP server has no fixed id to deep-link to (it is tenant-
 * minted at connect time — see `mcp-server-routes.ts`'s header). */
const ADD_MCP_SERVER_DEEP_LINK = "/plugins?connect=mcp";

async function runListConnections(
  env: WorkflowConnectionEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const [connections, mcpServers] = await Promise.all([
      listConnections(clientConfig(env)),
      listMcpServerConnections(clientConfig(env)),
    ]);
    const connected = connections.filter((entry) => entry.connected);
    const notConnected = connections.filter((entry) => !entry.connected);
    if (
      connected.length === 0 &&
      notConnected.length === 0 &&
      mcpServers.length === 0
    ) {
      return {
        callId: call.id,
        isError: false,
        content: "No connectors are registered in this workbench.",
      };
    }
    const connectedNames = [
      ...connected.map((entry) => entry.displayName),
      ...mcpServers.map((server) => `${server.name} (MCP server)`),
    ];
    const lines = [
      connectedNames.length > 0
        ? `Connected: ${connectedNames.join(", ")}.`
        : "Connected: none.",
      notConnected.length > 0
        ? `Not connected: ${notConnected.map((entry) => entry.displayName).join(", ")}.`
        : "Not connected: none.",
    ];
    return { callId: call.id, isError: false, content: lines.join(" ") };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runRequestConnection(
  env: WorkflowConnectionEnv,
  call: ToolCall,
  parsed: RequestConnectionInput,
): Promise<ToolResult> {
  const descriptor = CONNECTOR_REGISTRY[parsed.connector];
  if (descriptor !== undefined) {
    return {
      callId: call.id,
      isError: false,
      content:
        `To connect ${descriptor.displayName}, ask the human to open ` +
        `${connectDeepLink(descriptor.id)} and let you know once it's ` +
        `connected. This only hands over a link — connecting still ` +
        `happens in the browser, never automatically.`,
    };
  }

  // Not a fixed registry connector — check whether it is already a
  // connected MCP server under this name before assuming it needs one.
  try {
    const mcpServers = await listMcpServerConnections(clientConfig(env));
    const already = mcpServers.find(
      (server) =>
        server.slug === parsed.connector || server.name === parsed.connector,
    );
    if (already !== undefined) {
      return {
        callId: call.id,
        isError: false,
        content: `"${already.name}" is already connected as an MCP server.`,
      };
    }
  } catch (err) {
    return errorResult(call.id, err);
  }

  return {
    callId: call.id,
    isError: false,
    content:
      `"${parsed.connector}" isn't a fixed connector this workbench ` +
      `knows about, and no MCP server by that name is connected yet. ` +
      `If it's an MCP server, ask the human to open ` +
      `${ADD_MCP_SERVER_DEEP_LINK} and add it by name and URL there.`,
  };
}

/**
 * The `@corbits/connections-tools` bundle factory: two tools, neither
 * gated behind approval (see this file's header comment for why), three
 * env keys.
 */
export const connectionsTools = defineTool<WorkflowConnectionEnv>({
  id: "@corbits/connections-tools/connections",
  requires: ["hubConnectionsUrl", "sidecarToken", "address"],
  definitions: [
    { name: LIST_CONNECTIONS_TOOL },
    { name: REQUEST_CONNECTION_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_CONNECTIONS_TOOL,
        description:
          "see which third-party connections (e.g. Attio, Exa, Granola) " +
          "this workbench has connected, and which are still available " +
          "to connect. Read-only; use it before asking a human to " +
          "connect something, to check whether it's already connected.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: REQUEST_CONNECTION_TOOL,
        description:
          "get a link to hand the human so they can connect a specific " +
          "third-party connector. This tool cannot connect anything " +
          "itself — it only returns the link; the human finishes the " +
          "connection in the browser.",
        inputSchema: {
          type: "object",
          properties: {
            connector: {
              type: "string",
              description:
                "The connector's exact id as offered in this " +
                'workbench\'s connector registry (e.g. "granola", ' +
                '"exa") — never invented. Call list_connections first ' +
                "if unsure of the exact id.",
            },
          },
          required: ["connector"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_CONNECTIONS_TOOL:
          return runListConnections(env, call);
        case REQUEST_CONNECTION_TOOL: {
          const parsed = RequestConnectionInput(call.arguments);
          if (parsed instanceof type.errors) {
            return Promise.resolve(
              errorResult(
                call.id,
                new Error(
                  `request_connection received invalid input: ${parsed.summary}`,
                ),
              ),
            );
          }
          return runRequestConnection(env, call, parsed);
        }
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(
                `@corbits/connections-tools: unknown tool "${call.name}"`,
              ),
            ),
          );
      }
    },
  }),
});
