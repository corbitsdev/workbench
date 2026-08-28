// An in-process MCP server, built from the real
// `@modelcontextprotocol/sdk` server pieces (`Server` +
// `WebStandardStreamableHTTPServerTransport`), served over a real HTTP
// port via `Bun.serve`. Used by `mcp-tools`' own tests to prove the
// client half of this package against the real wire protocol rather
// than a hand-rolled JSON-RPC stub. Built on the low-level `Server` +
// `setRequestHandler`, not the `McpServer`/`registerTool` sugar, so
// this test helper needs no `zod` dependency of its own — the request
// schemas (`ListToolsRequestSchema`, `CallToolRequestSchema`) are the
// SDK's own, already a transitive dependency.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface StubMcpServerHandle {
  readonly url: string;
  readonly calls: { name: string; args: Record<string, unknown> }[];
  stop(): void;
}

/**
 * Starts a stub MCP server exposing one `echo` tool (read-only, per its
 * `readOnlyHint` annotation) and one `write_note` tool (not read-only)
 * so tests can prove `mcp_list_tools` surfaces the read-only signal
 * per-tool. When `requiredToken` is set, every request missing a
 * matching `authorization: Bearer <token>` header is rejected with 401
 * before it ever reaches the MCP transport -- proving the mediated
 * fetch's header actually lands on the wire.
 */
function buildServer(
  calls: { name: string; args: Record<string, unknown> }[],
  opts?: {
    echoDescription?: string;
    echoInputSchema?: Record<string, unknown>;
    echoResult?: string;
  },
): Server {
  const server = new Server(
    { name: "stub-mcp-server", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: opts?.echoDescription ?? "Echoes back its input.",
        inputSchema: opts?.echoInputSchema ?? {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "write_note",
        description: "Writes a note (not read-only).",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: request.params.name, args });
    if (request.params.name === "echo") {
      const text =
        opts?.echoResult !== undefined
          ? opts.echoResult
          : String(args["text"]);
      return { content: [{ type: "text", text }] };
    }
    if (request.params.name === "write_note") {
      return {
        content: [{ type: "text", text: `saved: ${String(args["text"])}` }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
    };
  });

  return server;
}

/**
 * Starts a stub MCP server exposing one `echo` tool (read-only, per its
 * `readOnlyHint` annotation) and one `write_note` tool (not read-only)
 * so tests can prove `mcp_list_tools` surfaces the read-only signal
 * per-tool. When `requiredToken` is set, every request missing a
 * matching `authorization: Bearer <token>` header is rejected with 401
 * before it ever reaches the MCP transport -- proving the mediated
 * fetch's header actually lands on the wire.
 *
 * A fresh `Server`/transport pair is minted per MCP session (this SDK's
 * `Server` tracks its own single `initialize` handshake, so one
 * instance cannot outlive a session) -- the same per-session-map
 * pattern a real multi-client MCP HTTP server runs, keyed by the
 * `Mcp-Session-Id` header `WebStandardStreamableHTTPServerTransport`
 * assigns on `initialize` and every client thereafter echoes back.
 * `@corbits/mcp-tools` opens a fresh client connection (and thus a
 * fresh session) per tool call, so this stub exercises exactly that
 * shape.
 */
export function startStubMcpServer(opts?: {
  requiredToken?: string;
  echoDescription?: string;
  echoInputSchema?: Record<string, unknown>;
  echoResult?: string;
}): StubMcpServerHandle {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const httpServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (opts?.requiredToken !== undefined) {
        const header = req.headers.get("authorization");
        if (header !== `Bearer ${opts.requiredToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      const sessionId = req.headers.get("mcp-session-id");
      const existing = sessionId !== null ? sessions.get(sessionId) : undefined;
      if (existing !== undefined) {
        return existing.handleRequest(req);
      }
      const transport: WebStandardStreamableHTTPServerTransport =
        new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id: string): void => {
            sessions.set(id, transport);
          },
          onsessionclosed: (id: string): void => {
            sessions.delete(id);
          },
        });
      await buildServer(calls, opts).connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    url: `http://localhost:${httpServer.port}/mcp`,
    calls,
    stop: () => httpServer.stop(true),
  };
}
