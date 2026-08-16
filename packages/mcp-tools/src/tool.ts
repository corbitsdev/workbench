// The `@corbits/mcp-tools` bundle: three meta-tools an agent uses to
// reach ANY MCP server a tenant has connected through Plugins, instead
// of a hand-built tool package per integration.
//
//   mcp_list_servers          -- which MCP servers are connected.
//   mcp_list_tools({server})  -- what tools a connected server exposes.
//   mcp_call({server, tool, arguments}) -- invoke one of those tools.
//
// Credentials: each connected server is a `mcp:<slug>` credential
// handle (`@workbench/connections`'s MCP connector; see that package's
// registry for the provider/credential shape). The slug is dynamic
// tenant data, unknown at package-publish time, so this package's
// `package.json` declares no static `interchange.credentials` entry
// the way `@corbits/web-search-tools` declares `exa` — a declaration is
// advisory only (`vendor/intx/tool-packaging/src/loader.ts`'s
// `readInterchangeCredentials` docs), so a dynamic handle still
// resolves through `env.credentials.resolve(handle)` at call time; it
// just never appears in a deploy-time credential-binding UI the way a
// statically-declared handle would. [Intx gap] filed in this
// package's README/PR description, not solved here.
//
// Approval: `mcp_call` can execute an arbitrary downstream tool
// (write a row, send a message, delete something), so it declares
// `approval: "ask"` unconditionally in its static `ToolDeclaration` —
// the only place `@intx/agent`'s `toolApprovalEffect` reads a floor
// from (`vendor/intx/agent/src/tool.ts`). That floor is fixed per tool
// NAME at deploy time, one grant for "mcp_call" covering every server
// and every downstream tool alike; there is no per-invocation floor in
// this substrate today, so a downstream tool's own `readOnlyHint`
// annotation cannot lower `mcp_call`'s gate dynamically. This bundle
// still surfaces `readOnlyHint` in `mcp_list_tools`' output (and in
// `mcp_call`'s tool description, which tells the model to call
// `mcp_list_tools` first) so a human approver reviewing the pending
// call sees whether the tool the model is about to invoke claims to
// be read-only — an honest signal, not an enforcement mechanism. This
// is the [Intx gap] the task named up front (no dynamic/late-bound
// approval floor); "ask always" is the safe over-approximation of "ask
// unless read-only" until the runtime grows a per-call floor.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import { callMcpTool, listMcpTools, withMcpConnection } from "./mcp-client";
import { listMcpServers, type McpServerListing } from "./registry-client";

export const MCP_LIST_SERVERS_TOOL = "mcp_list_servers";
export const MCP_LIST_TOOLS_TOOL = "mcp_list_tools";
export const MCP_CALL_TOOL = "mcp_call";

/** `mcp:<slug>` -- the credential handle convention every connected
 * MCP server binds to (see this file's header comment). */
export function mcpCredentialHandle(slug: string): string {
  return `mcp:${slug}`;
}

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential
 * capability plus the same workflow-run hub-reach fields
 * `@corbits/connections-tools` uses to list connections. */
export interface McpToolsEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
  readonly hubConnectionsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function registryConfig(env: McpToolsEnv) {
  return {
    hubConnectionsUrl: env.hubConnectionsUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

async function findServer(
  env: McpToolsEnv,
  slug: string,
): Promise<McpServerListing | null> {
  const servers = await listMcpServers(registryConfig(env));
  return servers.find((server) => server.slug === slug) ?? null;
}

/** Resolves the mediated, origin-pinned fetch this server's connected
 * credential shapes -- `null` when no credential is bound (an absent
 * `env.credentials`, an unbound handle, or a denied grant), never a
 * thrown error out of the tool. */
async function resolveMcpFetch(
  env: McpToolsEnv,
  slug: string,
): Promise<typeof fetch | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated: MediatedCredential = await env.credentials.resolve(
      mcpCredentialHandle(slug),
    );
    if (mediated.kind !== "http") return null;
    return mediated.fetch as unknown as typeof fetch;
  } catch {
    return null;
  }
}

async function runListServers(
  env: McpToolsEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const servers = await listMcpServers(registryConfig(env));
    if (servers.length === 0) {
      return {
        callId: call.id,
        isError: false,
        content:
          "No MCP servers are connected. Use request_connection or " +
          "point the human to Plugins to add one.",
      };
    }
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({
        servers: servers.map((server) => ({
          server: server.slug,
          name: server.name,
        })),
      }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

const ListToolsInput = type({ server: "string > 0" });
const CallInput = type({
  server: "string > 0",
  tool: "string > 0",
  "arguments?": "object",
});

async function runListTools(
  env: McpToolsEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = ListToolsInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(
        `${MCP_LIST_TOOLS_TOOL} received invalid input: ${parsed.summary}`,
      ),
    );
  }
  try {
    const server = await findServer(env, parsed.server);
    if (server === null) {
      return errorResult(
        call.id,
        new Error(
          `MCP server "${parsed.server}" is not connected. Call ` +
            `${MCP_LIST_SERVERS_TOOL} to see the connected servers.`,
        ),
      );
    }
    const fetchImpl = await resolveMcpFetch(env, parsed.server);
    if (fetchImpl === null) {
      return errorResult(
        call.id,
        new Error(`MCP server "${parsed.server}" is not connected.`),
      );
    }
    const tools = await withMcpConnection(
      { url: server.url, fetchImpl },
      (client) => listMcpTools(client),
    );
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({
        server: parsed.server,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          readOnly: tool.annotations?.readOnlyHint === true,
        })),
      }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runCall(env: McpToolsEnv, call: ToolCall): Promise<ToolResult> {
  const parsed = CallInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`${MCP_CALL_TOOL} received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const server = await findServer(env, parsed.server);
    if (server === null) {
      return errorResult(
        call.id,
        new Error(
          `MCP server "${parsed.server}" is not connected. Call ` +
            `${MCP_LIST_SERVERS_TOOL} to see the connected servers.`,
        ),
      );
    }
    const fetchImpl = await resolveMcpFetch(env, parsed.server);
    if (fetchImpl === null) {
      return errorResult(
        call.id,
        new Error(`MCP server "${parsed.server}" is not connected.`),
      );
    }
    const result = await withMcpConnection(
      { url: server.url, fetchImpl },
      (client) =>
        callMcpTool(client, {
          name: parsed.tool,
          arguments: (parsed.arguments as Record<string, unknown>) ?? {},
        }),
    );
    return {
      callId: call.id,
      isError: result.isError,
      content: JSON.stringify(result.content),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/mcp-tools` bundle factory: `mcp_list_servers` and
 * `mcp_list_tools` read only (no `approval` key, matching
 * `@corbits/connections-tools`' `list_connections`); `mcp_call` is
 * gated `approval: "ask"` unconditionally (see this file's header
 * comment for why it cannot vary by downstream tool).
 */
export const mcpTools = defineTool<McpToolsEnv>({
  id: "@corbits/mcp-tools/mcp",
  requires: ["credentials", "hubConnectionsUrl", "sidecarToken", "address"],
  definitions: [
    { name: MCP_LIST_SERVERS_TOOL },
    { name: MCP_LIST_TOOLS_TOOL },
    { name: MCP_CALL_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: MCP_LIST_SERVERS_TOOL,
        description:
          "Lists the MCP servers this workbench currently has connected " +
          "(added under Plugins). Read-only. Returns each server's slug " +
          "(pass as `server` to mcp_list_tools/mcp_call) and display name.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: MCP_LIST_TOOLS_TOOL,
        description:
          "Lists the tools one connected MCP server exposes, including " +
          "each tool's input schema and whether the server marks it " +
          "read-only. ALWAYS call this before mcp_call for a server you " +
          "haven't already inspected in this conversation — never guess " +
          "a tool name or its arguments.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "The server's slug, exactly as returned by " +
                `${MCP_LIST_SERVERS_TOOL}.`,
            },
          },
          required: ["server"],
        },
      },
      {
        name: MCP_CALL_TOOL,
        description:
          "Calls one tool on a connected MCP server. Always requires " +
          "human approval before it runs, regardless of the downstream " +
          `tool. Call ${MCP_LIST_TOOLS_TOOL} first to get the exact ` +
          "tool name and input schema — never invent either.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `The server's slug, from ${MCP_LIST_SERVERS_TOOL}.`,
            },
            tool: {
              type: "string",
              description: `The tool's exact name, from ${MCP_LIST_TOOLS_TOOL}.`,
            },
            arguments: {
              type: "object",
              description: "The tool's input, matching its inputSchema.",
            },
          },
          required: ["server", "tool"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case MCP_LIST_SERVERS_TOOL:
          return runListServers(env, call);
        case MCP_LIST_TOOLS_TOOL:
          return runListTools(env, call);
        case MCP_CALL_TOOL:
          return runCall(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/mcp-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
