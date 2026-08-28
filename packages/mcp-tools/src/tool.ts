// The `@corbits/mcp-tools` bundle: three meta-tools an agent uses to
// reach ANY MCP server a tenant has connected through Plugins, instead
// of a hand-built tool package per integration.
//
//   mcp_list_servers -- which MCP servers are connected.
//   mcp_list_tools   -- discover tools: no args for a truncated
//                        catalog of every server, {pattern} to regex
//                        search names across all servers, {server} for
//                        one server's truncated list, {server, toolName}
//                        for one tool's truncated schema.
//   mcp_call({server, tool, arguments}) -- invoke one of those tools.
//
// Credentials: each connected server is a `mcp.<slug>` credential
// handle (`@workbench/connections`'s MCP connector, stored under a
// `mcp:<slug>` provider row name -- see that package's registry for the
// provider/credential shape). The slug is dynamic
// tenant data, unknown at package-publish time, so this package's
// `package.json` declares no static `interchange.credentials` entry
// the way `@corbits/web-search-tools` declares `exa` — a declaration is
// advisory only (`@intx/tool-packaging/src/loader.ts`'s
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
// from (`@intx/agent/src/tool.ts`). That floor is fixed per tool
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
// approval floor); "ask always" stays the static floor. CL-6345 layers
// the grant allowance on top at the hub: a parked `mcp_call` whose
// downstream tool the server itself marks `readOnlyHint: true` (see
// `./allowance.ts`'s classifier, which re-verifies the claim live) and
// whose `mcp:<slug>` connection resource a standing `allow` grant
// covers is auto-approved through the native resolve machinery, so it
// proceeds without a human while every write still parks.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  callMcpTool,
  listMcpTools,
  withMcpConnection,
  type McpToolInfo,
} from "./mcp-client";
import { listMcpServers, type McpServerListing } from "./registry-client";

export const MCP_LIST_SERVERS_TOOL = "mcp_list_servers";
export const MCP_LIST_TOOLS_TOOL = "mcp_list_tools";
export const MCP_READ_TOOL = "mcp_read";
export const MCP_CALL_TOOL = "mcp_call";

/** `mcp.<slug>` -- the credential handle convention every connected
 * MCP server binds to (see this file's header comment). Dots, not a
 * colon, so the handle conforms to `@intx/types`' `ToolCredentialHandle`
 * grammar (`/^[a-z0-9][a-z0-9._-]*$/`) -- distinct from the `mcp:<slug>`
 * PROVIDER row naming `@workbench/connections` stores, which has no such
 * constraint. */
export function mcpCredentialHandle(slug: string): string {
  return `mcp.${slug}`;
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
): Promise<{ fetch: typeof fetch } | { fetch: null; reason: string }> {
  if (env.credentials === undefined) {
    return { fetch: null, reason: "the run has no credential capability" };
  }
  try {
    const mediated: MediatedCredential = await env.credentials.resolve(
      mcpCredentialHandle(slug),
    );
    if (mediated.kind !== "http") {
      return {
        fetch: null,
        reason: `credential resolved to kind "${mediated.kind}", not http`,
      };
    }
    return { fetch: mediated.fetch as unknown as typeof fetch };
  } catch (cause) {
    return {
      fetch: null,
      reason: `credential resolve failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
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

const ListToolsInput = type({
  "server?": "string > 0",
  "toolName?": "string > 0",
  "pattern?": "string > 0",
});
const CallInput = type({
  server: "string > 0",
  tool: "string > 0",
  "arguments?": "object",
});

const TRUNCATE_LENGTH = 100;
const TRUNCATE_SUFFIX = "… [truncated]";
const MCP_READ_MAX_CHARS = 8_000;

function truncateDescription(description: string | undefined): string {
  if (description === undefined) return "";
  if (description.length <= TRUNCATE_LENGTH) return description;
  return description.slice(0, TRUNCATE_LENGTH) + TRUNCATE_SUFFIX;
}

function truncateSchema(schema: unknown): string {
  return truncateDescription(JSON.stringify(schema));
}

function boundReadContent(content: string): string {
  if (content.length <= MCP_READ_MAX_CHARS) return content;
  const keep = Math.max(0, MCP_READ_MAX_CHARS - TRUNCATE_SUFFIX.length);
  return content.slice(0, keep) + TRUNCATE_SUFFIX;
}

function toolSummary(tool: McpToolInfo) {
  return {
    name: tool.name,
    description: truncateDescription(tool.description),
    inputSchema: truncateSchema(tool.inputSchema),
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

/** Loads one server's tools, or the resolve-failure reason (mirrors
 * `resolveMcpFetch`'s honest-degrade contract — the reason is threaded
 * to the caller's error text, never swallowed). */
async function loadServerTools(
  env: McpToolsEnv,
  server: McpServerListing,
): Promise<
  { tools: readonly McpToolInfo[] } | { tools: null; reason: string }
> {
  const resolved = await resolveMcpFetch(env, server.slug);
  if (resolved.fetch === null) return { tools: null, reason: resolved.reason };
  const fetchImpl = resolved.fetch;
  const tools = await withMcpConnection(
    { url: server.url, fetchImpl },
    (client) => listMcpTools(client),
  );
  return { tools };
}

/** `{server}` -- full tool list for one connected server. */
async function runListToolsForServer(
  env: McpToolsEnv,
  call: ToolCall,
  slug: string,
): Promise<ToolResult> {
  const server = await findServer(env, slug);
  if (server === null) {
    return errorResult(
      call.id,
      new Error(
        `MCP server "${slug}" is not connected. Call ` +
          `${MCP_LIST_SERVERS_TOOL} to see the connected servers.`,
      ),
    );
  }
  const loaded = await loadServerTools(env, server);
  if (loaded.tools === null) {
    return errorResult(
      call.id,
      new Error(
        `MCP server "${slug}" is not reachable from this run: ${loaded.reason}`,
      ),
    );
  }
  return {
    callId: call.id,
    isError: false,
    content: JSON.stringify({
      server: slug,
      tools: loaded.tools.map(toolSummary),
    }),
  };
}

/** `{server, toolName}` -- one tool's full schema. */
async function runListToolsForTool(
  env: McpToolsEnv,
  call: ToolCall,
  slug: string,
  toolName: string,
): Promise<ToolResult> {
  const server = await findServer(env, slug);
  if (server === null) {
    return errorResult(
      call.id,
      new Error(
        `MCP server "${slug}" is not connected. Call ` +
          `${MCP_LIST_SERVERS_TOOL} to see the connected servers.`,
      ),
    );
  }
  const loaded = await loadServerTools(env, server);
  if (loaded.tools === null) {
    return errorResult(
      call.id,
      new Error(
        `MCP server "${slug}" is not reachable from this run: ${loaded.reason}`,
      ),
    );
  }
  const tool = loaded.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return errorResult(
      call.id,
      new Error(
        `MCP server "${slug}" has no tool named "${toolName}". Call ` +
          `${MCP_LIST_TOOLS_TOOL} with just {server} to see its tools.`,
      ),
    );
  }
  return {
    callId: call.id,
    isError: false,
    content: JSON.stringify({ server: slug, tool: toolSummary(tool) }),
  };
}

/** `{pattern}` -- regex search of tool AND server names across every
 * connected server. */
async function runListToolsForPattern(
  env: McpToolsEnv,
  call: ToolCall,
  pattern: string,
): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    return errorResult(
      call.id,
      new Error(`"${pattern}" is not a valid regex: ${String(err)}`),
    );
  }
  const servers = await listMcpServers(registryConfig(env));
  const matches: {
    server: string;
    tool: ReturnType<typeof toolSummary>;
  }[] = [];
  const unreachable: { server: string; reason: string }[] = [];
  for (const server of servers) {
    const serverMatches = regex.test(server.slug) || regex.test(server.name);
    const loaded = await loadServerTools(env, server);
    if (loaded.tools === null) {
      unreachable.push({ server: server.slug, reason: loaded.reason });
      continue;
    }
    for (const tool of loaded.tools) {
      if (serverMatches || regex.test(tool.name)) {
        matches.push({ server: server.slug, tool: toolSummary(tool) });
      }
    }
  }
  return {
    callId: call.id,
    isError: false,
    content: JSON.stringify(
      unreachable.length > 0
        ? { pattern, matches, unreachable }
        : { pattern, matches },
    ),
  };
}

/** No args -- a catalog of every connected server with tool names and
 * truncated descriptions, cheap enough to skim before drilling in. */
async function runListToolsCatalog(
  env: McpToolsEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const servers = await listMcpServers(registryConfig(env));
  const catalog = [];
  for (const server of servers) {
    const loaded = await loadServerTools(env, server);
    catalog.push({
      server: server.slug,
      name: server.name,
      ...(loaded.tools === null
        ? { tools: [], unreachable: loaded.reason }
        : {
            tools: loaded.tools.map((tool) => ({
              name: tool.name,
              description: truncateDescription(tool.description),
              schema: truncateSchema(tool.inputSchema),
            })),
          }),
    });
  }
  return {
    callId: call.id,
    isError: false,
    content: JSON.stringify({ servers: catalog }),
  };
}

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
  if (parsed.toolName !== undefined && parsed.server === undefined) {
    return errorResult(
      call.id,
      new Error(`${MCP_LIST_TOOLS_TOOL}'s "toolName" requires "server".`),
    );
  }
  try {
    if (parsed.pattern !== undefined) {
      return await runListToolsForPattern(env, call, parsed.pattern);
    }
    if (parsed.server !== undefined) {
      return parsed.toolName !== undefined
        ? await runListToolsForTool(env, call, parsed.server, parsed.toolName)
        : await runListToolsForServer(env, call, parsed.server);
    }
    return await runListToolsCatalog(env, call);
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/** `mcp_read`'s live authz gate: a tool only executes read-only when
 * the target server's OWN `tools/list` (fetched fresh here, never
 * trusted from the model's claim) marks it `readOnlyHint === true`. */
export function readOnlyGate(
  tools: readonly McpToolInfo[],
  toolName: string,
): { allowed: true; tool: McpToolInfo } | { allowed: false; reason: string } {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      allowed: false,
      reason:
        `MCP server has no tool named "${toolName}". Call ` +
        `${MCP_LIST_TOOLS_TOOL} to see its tools.`,
    };
  }
  if (tool.annotations?.readOnlyHint !== true) {
    return {
      allowed: false,
      reason:
        `Tool "${toolName}" is not marked read-only. Use ${MCP_CALL_TOOL} ` +
        "instead, which asks for human approval.",
    };
  }
  return { allowed: true, tool };
}

async function runRead(env: McpToolsEnv, call: ToolCall): Promise<ToolResult> {
  const parsed = CallInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`${MCP_READ_TOOL} received invalid input: ${parsed.summary}`),
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
    const resolved = await resolveMcpFetch(env, parsed.server);
    if (resolved.fetch === null) {
      return errorResult(
        call.id,
        new Error(
          `MCP server "${parsed.server}" is not reachable from this run: ${resolved.reason}`,
        ),
      );
    }
    const result = await withMcpConnection(
      { url: server.url, fetchImpl: resolved.fetch },
      async (client) => {
        const tools = await listMcpTools(client);
        const gate = readOnlyGate(tools, parsed.tool);
        if (!gate.allowed) {
          return { isError: true as const, content: gate.reason };
        }
        return callMcpTool(client, {
          name: parsed.tool,
          arguments: (parsed.arguments as Record<string, unknown>) ?? {},
        });
      },
    );
    return {
      callId: call.id,
      isError: result.isError,
      content: boundReadContent(
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      ),
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
    const resolved = await resolveMcpFetch(env, parsed.server);
    if (resolved.fetch === null) {
      return errorResult(
        call.id,
        new Error(
          `MCP server "${parsed.server}" is not reachable from this run: ${resolved.reason}`,
        ),
      );
    }
    const result = await withMcpConnection(
      { url: server.url, fetchImpl: resolved.fetch },
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
    { name: MCP_READ_TOOL },
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
          "Discovers tools on connected MCP servers. Call this once to " +
          "find the tool you need, then mcp_call — minimize round-trips; " +
          "never guess a tool name or its arguments. Four modes, pick " +
          "the narrowest that fits: no arguments returns a catalog of " +
          "every connected server with its tool names and truncated " +
          "descriptions, for a first skim. `{pattern}` regex-searches " +
          "tool AND server names across every connected server — use " +
          "this when you're not sure which server has the tool you " +
          "want. `{server}` returns one server's full tool list with " +
          "full descriptions. `{server, toolName}` returns that one " +
          "tool's full input schema, once you know exactly which tool " +
          "you're calling. Never dump a whole server's catalog into a " +
          "reply to the human.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "The server's slug, exactly as returned by " +
                `${MCP_LIST_SERVERS_TOOL}. Omit with \`pattern\` to ` +
                "search across all servers, or omit both for the full " +
                "catalog.",
            },
            toolName: {
              type: "string",
              description:
                "A specific tool's exact name, to get its full input " +
                "schema. Requires `server`.",
            },
            pattern: {
              type: "string",
              description:
                "A regex tested against every connected server's tool " +
                "and server names. Use this when unsure which server " +
                "has the tool you want.",
            },
          },
        },
      },
      {
        name: MCP_READ_TOOL,
        description:
          "Calls a READ-ONLY tool on a connected MCP server — no human " +
          "approval needed. Only works when the server's own tools/list " +
          "marks the tool `readOnlyHint: true`; this is re-checked live " +
          `at call time, never assumed. Use for reads. Call ` +
          `${MCP_LIST_TOOLS_TOOL} once first to find the tool and its ` +
          `exact name and input schema. If this errors telling you the ` +
          `tool isn't read-only, use ${MCP_CALL_TOOL} instead.`,
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
      {
        name: MCP_CALL_TOOL,
        description:
          "Calls any tool — read or write — on a connected MCP server. " +
          "Requires human approval before it runs unless the downstream " +
          "tool is verified read-only and the connection carries a " +
          `standing read grant; prefer ${MCP_READ_TOOL} for read-only ` +
          `tools, which needs no approval. Call ${MCP_LIST_TOOLS_TOOL} ` +
          "once first to find the tool (pattern search when unsure " +
          "which server) and get its exact name and input schema — " +
          "never invent either.",
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
        case MCP_READ_TOOL:
          return runRead(env, call);
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
