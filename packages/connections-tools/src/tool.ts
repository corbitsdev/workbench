// The `@corbits/connections-tools` bundle: `list_connections` and
// `request_connection`, an agent's in-chat way to see which third-party
// connections (Attio, Exa, Granola, ...) this workbench already has
// live, and to hand the human a link to connect one that isn't yet.
// Both tools reuse the existing connections plane end to end
// (`@corbits/connections`'s `CONNECTOR_REGISTRY` and the workflow-run
// route it exposes) — neither invents new state, and neither completes
// OAuth itself; only a human, acting in the browser through the
// existing Connections settings surface, can finish a connect flow.
//
// Both tools also read `@corbits/connections`' MCP-server listing
// (CL-6142's `/api/workflow-connections/mcp-servers`, backed by
// `@corbits/mcp-tools`' own `mcp_list_servers` route) — a tenant-minted
// `mcp:<slug>` connector has no fixed registry id, so `list_connections`
// folds it into the connected list by name, and `request_connection`
// falls back to it (see `ADD_MCP_SERVER_GUIDANCE`) before reporting an
// unknown connector.
//
// Approval: `list_connections` reads only, so it declares no `approval`
// key (matching a read-style tool, e.g. `@corbits/memory-tools`' search
// tool). `request_connection` posts a `connect-service` card into the
// caller's own room — the same post-into-my-own-channel surface
// `@corbits/interaction-tools`' `ask_user` uses without approval — and
// nothing more. Neither tool is architecturally required to gate behind
// a human: nothing here writes a credential, calls a third party, or
// exposes a secret; connecting itself still happens only in the
// browser, through the card. (Contrast `@corbits/capability-tools`'
// `request_capability`, which mutates a workflow definition and so
// genuinely needs `approval: "ask"`.)
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { CONNECTOR_REGISTRY } from "@corbits/connections";
import {
  MCP_PRESETS,
  mcpPresetByName,
} from "@corbits/connections/mcp-presets";
import { type } from "arktype";

import {
  listConnections,
  listMcpServerConnections,
  NoOwnRoomError,
  postConnectServiceBlock,
} from "./client";

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
  "reason?": "string > 0",
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

/** `/plugins?connect=<connectorId>` — a deep link into the Plugins
 * panel that auto-opens the named connector's own connect card
 * (CL-7141: `apps/web/src/pages/plugins-page.tsx` reads this `connect`
 * query param on mount and hands it to the same
 * `requestPluginsConnect` path an in-app "Fix it" click uses). */
function connectDeepLink(connectorId: string): string {
  return `/plugins?connect=${connectorId}`;
}

/** There is no fixed id — and no generic add-custom-MCP-server form at
 * all — to deep-link to (CL-7141; see
 * `packages/plugins-ui/src/mcp-servers-section.tsx`'s header for why:
 * only curated presets are self-serve installable, an MCP server has
 * no id before it's tenant-minted at connect time). So this stays
 * plain prose pointed at the Plugins page's own connector list rather
 * than a link that would land on nothing. */
const ADD_MCP_SERVER_GUIDANCE =
  "point them to the Plugins page in this workbench — every connector it can add lives there";

/** `/plugins?connect=mcp:<slug>` — a curated preset's own card
 * (CL-6152). Presets are still tenant-minted `mcp:<slug>` connections
 * once connected, but the *card* a human clicks to start one is fixed
 * and known ahead of time, unlike a hand-typed custom MCP server. */
function presetDeepLink(slug: string): string {
  return `/plugins?connect=mcp:${slug}`;
}

/** Every `CONNECTOR_REGISTRY` id a curated MCP preset now fronts —
 * excluded from the raw api-key connector tallies below so a service
 * with both an old api-key entry and a new preset (Granola, Exa,
 * Linear) is only ever reported once, under its preset's own connected/
 * not-connected state. */
const PRESET_FRONTED_IDS = new Set(MCP_PRESETS.map((preset) => preset.slug));

async function runListConnections(
  env: WorkflowConnectionEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const [connections, mcpServers] = await Promise.all([
      listConnections(clientConfig(env)),
      listMcpServerConnections(clientConfig(env)),
    ]);
    const connectedMcpSlugs = new Set(mcpServers.map((server) => server.slug));
    const registryEntries = connections.filter(
      (entry) => !PRESET_FRONTED_IDS.has(entry.id),
    );
    const connected = registryEntries.filter((entry) => entry.connected);
    const notConnected = registryEntries.filter((entry) => !entry.connected);
    const otherMcpServers = mcpServers.filter(
      (server) => !PRESET_FRONTED_IDS.has(server.slug),
    );
    // A preset service counts as connected through EITHER door: its MCP
    // server, or a plain key stored under the same connector id — a
    // Granola key connected before the MCP card existed must never
    // read as "Not connected".
    const keyConnectedIds = new Set(
      connections.filter((entry) => entry.connected).map((entry) => entry.id),
    );
    const presetConnected = MCP_PRESETS.filter(
      (preset) =>
        connectedMcpSlugs.has(preset.slug) || keyConnectedIds.has(preset.slug),
    );
    const presetNotConnected = MCP_PRESETS.filter(
      (preset) =>
        !connectedMcpSlugs.has(preset.slug) &&
        !keyConnectedIds.has(preset.slug),
    );

    if (
      connected.length === 0 &&
      notConnected.length === 0 &&
      otherMcpServers.length === 0 &&
      MCP_PRESETS.length === 0
    ) {
      return {
        callId: call.id,
        isError: false,
        content: "No connectors are registered in this workbench.",
      };
    }
    const connectedNames = [
      ...connected.map((entry) => entry.displayName),
      ...presetConnected.map((preset) =>
        connectedMcpSlugs.has(preset.slug)
          ? `${preset.displayName} (via MCP)`
          : preset.displayName,
      ),
      ...otherMcpServers.map((server) => `${server.name} (MCP server)`),
    ];
    const notConnectedNames = [
      ...notConnected.map((entry) => entry.displayName),
      ...presetNotConnected.map((preset) => preset.displayName),
    ];
    const lines = [
      connectedNames.length > 0
        ? `Connected: ${connectedNames.join(", ")}.`
        : "Connected: none.",
      notConnectedNames.length > 0
        ? `Not connected: ${notConnectedNames.join(", ")}.`
        : "Not connected: none.",
    ];
    return { callId: call.id, isError: false, content: lines.join(" ") };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

function cardPostedResult(callId: string, displayName: string): ToolResult {
  return {
    callId,
    isError: false,
    content:
      `A Connect ${displayName} card is now in the room. Keep helping in ` +
      `the meantime: do everything you can without it right away (draft ` +
      `the work now, offer to finish once connected), and point at the ` +
      `card rather than any settings page. The room gets a message once ` +
      `${displayName} is connected — pick the task back up then.`,
  };
}

async function postCardOrLink(
  env: WorkflowConnectionEnv,
  call: ToolCall,
  card: { connectorId: string; displayName: string; reason: string },
  deepLink: string,
): Promise<ToolResult> {
  try {
    await postConnectServiceBlock(clientConfig(env), card);
  } catch (err) {
    if (err instanceof NoOwnRoomError) {
      return {
        callId: call.id,
        isError: false,
        content:
          `To connect ${card.displayName}, ask the human to open ` +
          `${deepLink} and let you know once it's connected. Connecting ` +
          `still happens in the browser, never automatically.`,
      };
    }
    return errorResult(call.id, err);
  }
  return cardPostedResult(call.id, card.displayName);
}

async function runRequestConnection(
  env: WorkflowConnectionEnv,
  call: ToolCall,
  parsed: RequestConnectionInput,
): Promise<ToolResult> {
  // Checked ahead of the fixed registry: a curated preset (Granola, Exa,
  // Linear) is now the featured card for its service — a human asking
  // to "connect Exa" should land on that MCP card, not the old api-key
  // one, which `settings-ui`/`plugins-ui` no longer render as a separate
  // card at all.
  const preset = mcpPresetByName(parsed.connector);
  if (preset !== undefined) {
    try {
      const mcpServers = await listMcpServerConnections(clientConfig(env));
      const already = mcpServers.find((server) => server.slug === preset.slug);
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
    return postCardOrLink(
      env,
      call,
      {
        connectorId: preset.slug,
        displayName: preset.displayName,
        reason:
          parsed.reason ??
          `Connect ${preset.displayName} — ${preset.description}.`,
      },
      presetDeepLink(preset.slug),
    );
  }

  const descriptor = CONNECTOR_REGISTRY[parsed.connector];
  if (descriptor !== undefined) {
    try {
      const connections = await listConnections(clientConfig(env));
      const entry = connections.find(
        (candidate) => candidate.id === descriptor.id,
      );
      if (entry !== undefined && entry.connected) {
        return {
          callId: call.id,
          isError: false,
          content: `${descriptor.displayName} is already connected.`,
        };
      }
    } catch (err) {
      return errorResult(call.id, err);
    }
    return postCardOrLink(
      env,
      call,
      {
        connectorId: descriptor.id,
        displayName: descriptor.displayName,
        reason:
          parsed.reason ??
          `Connect ${descriptor.displayName} so I can pick this up for you.`,
      },
      connectDeepLink(descriptor.id),
    );
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
      `This workspace can't connect "${parsed.connector}" yet. Tell the ` +
      `human plainly what you can still do without it, and keep helping ` +
      `with that now — never ask them to go set up servers or report ` +
      `back. If they want to add it themselves, ${ADD_MCP_SERVER_GUIDANCE}.`,
  };
}

/**
 * The `@corbits/connections-tools` bundle factory: two tools, neither
 * gated behind approval (see this file's header comment for why), three
 * env keys.
 */
export const connectionsTools = defineTool<WorkflowConnectionEnv>({
  id: "@corbits/connections-tools/conn",
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
          "put a one-click connect card for a third-party connector in " +
          "the room, so the human can connect it right there. This tool " +
          "cannot connect anything itself — the human finishes the " +
          "connection in the browser. Call it the moment a request " +
          "needs a service that isn't connected, then keep helping " +
          "with everything you can do without it.",
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
            reason: {
              type: "string",
              description:
                "One plain sentence, in the human's own terms, saying " +
                'what connecting unlocks right now — e.g. "Connect ' +
                'Gmail so I can send this for you." Always speak to ' +
                "their request, never to the system.",
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
