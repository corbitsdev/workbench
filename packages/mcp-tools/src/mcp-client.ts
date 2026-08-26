// A short-lived MCP client: connect, do one thing (discover tools or
// call one), disconnect. Wraps the official `@modelcontextprotocol/sdk`
// client over its Streamable HTTP transport rather than hand-rolling
// JSON-RPC framing or SSE parsing — the transport speaks the real MCP
// wire protocol.
//
// One connection per tool invocation, not a pooled/persistent session:
// `mcp_list_tools`/`mcp_call` each run inside a single tool `run()`
// call with no cross-call state to keep warm, and a fresh
// `initialize` handshake is cheap next to the honesty of never holding
// a stale session across calls that may be minutes apart.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export const MCP_CLIENT_NAME = "corbits-workbench";
export const MCP_CLIENT_VERSION = "0.0.1";

/** Per-request MCP timeout. The SDK default is 60s — the documented
 * duration of long tools such as Canva `generate-design`. Chat turns
 * are 5 minutes; two minutes sits in between so a slow tool can finish
 * without a hung call outliving the turn. */
export const MCP_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

const MCP_REQUEST_OPTIONS = { timeout: MCP_REQUEST_TIMEOUT_MS } as const;

export interface McpToolAnnotations {
  readonly title?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  readonly isError: boolean;
  readonly content: unknown;
}

/**
 * Connects to `url` over Streamable HTTP, injecting `fetchImpl` for
 * every request the transport makes (the caller's mediated,
 * origin-pinned credential fetch — see `tool.ts`'s
 * `resolveMcpFetch`). Throws on any connect, discovery, or call
 * failure; callers degrade that at their own tool boundary.
 */
export async function withMcpConnection<T>(
  args: { url: string; fetchImpl: typeof fetch },
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    name: MCP_CLIENT_NAME,
    version: MCP_CLIENT_VERSION,
  });
  const transport = new StreamableHTTPClientTransport(new URL(args.url), {
    fetch: args.fetchImpl as unknown as FetchLike,
  });
  // `StreamableHTTPClientTransport`'s optional `sessionId` widens to
  // `string | undefined` under this repo's `exactOptionalPropertyTypes`,
  // which the SDK's own `Transport` interface (built without that flag)
  // does not declare -- a real structural match, not an unsafe cast.
  await client.connect(transport as unknown as Transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

/** `tools/list` against an already-open connection, normalized to the
 * shape `mcp_list_tools` reports. */
export async function listMcpTools(
  client: Client,
): Promise<readonly McpToolInfo[]> {
  const result = await client.listTools(undefined, MCP_REQUEST_OPTIONS);
  return result.tools.map((tool) => {
    const base: McpToolInfo = {
      name: tool.name,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    };
    const withDescription =
      tool.description !== undefined
        ? { ...base, description: tool.description }
        : base;
    return tool.annotations !== undefined
      ? { ...withDescription, annotations: tool.annotations }
      : withDescription;
  });
}

/** `tools/call` against an already-open connection, normalized to the
 * shape `mcp_call` reports. */
export async function callMcpTool(
  client: Client,
  args: { name: string; arguments: Record<string, unknown> },
): Promise<McpCallResult> {
  const result = await client.callTool(
    {
      name: args.name,
      arguments: args.arguments,
    },
    undefined,
    MCP_REQUEST_OPTIONS,
  );
  return {
    isError: result.isError === true,
    content: result.content,
  };
}
