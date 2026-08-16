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
// Approval: `list_connections` reads only, so it declares no `approval`
// key (matching a read-style tool, e.g. `@corbits/memory-tools`' search
// tool). `request_connection` performs no HTTP call and mutates
// nothing either — it validates a connector id against the same static
// registry and returns a deep-link string — so it also declares no
// `approval` key. Neither tool is architecturally required to gate
// behind a human: nothing here writes a credential, calls a third
// party, or exposes a secret. (Contrast `@corbits/capability-tools`'
// `request_capability`, which mutates a workflow definition and so
// genuinely needs `approval: "ask"`.)
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { CONNECTOR_REGISTRY } from "@workbench/connections";
import { type } from "arktype";

import { listConnections } from "./client";

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

async function runListConnections(
  env: WorkflowConnectionEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const connections = await listConnections(clientConfig(env));
    if (connections.length === 0) {
      return {
        callId: call.id,
        isError: false,
        content: "No connectors are registered in this workbench.",
      };
    }
    const connected = connections.filter((entry) => entry.connected);
    const notConnected = connections.filter((entry) => !entry.connected);
    const lines = [
      connected.length > 0
        ? `Connected: ${connected.map((entry) => entry.displayName).join(", ")}.`
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

function runRequestConnection(
  call: ToolCall,
  parsed: RequestConnectionInput,
): ToolResult {
  const descriptor = CONNECTOR_REGISTRY[parsed.connector];
  if (descriptor === undefined) {
    const known = Object.keys(CONNECTOR_REGISTRY).join(", ");
    return errorResult(
      call.id,
      new Error(
        `"${parsed.connector}" isn't a connector this workbench knows about. Known connectors: ${known}.`,
      ),
    );
  }
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
          return Promise.resolve(runRequestConnection(call, parsed));
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
