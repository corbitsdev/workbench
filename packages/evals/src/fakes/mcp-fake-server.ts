// Stands up a real MCP server (CL-6338) — same SDK pieces
// `@corbits/mcp-tools`' own test double already proves against
// (`packages/mcp-tools/test/stub-mcp-server.ts`) — that replays a
// checked-in `McpFakeRecording` (./recording.ts) instead of a
// hand-written tool set. Connected into a tenant through the exact
// same `POST /mcp-servers` route real users use
// (`packages/connections/src/mcp-server-routes.ts`) — this file only
// serves the wire protocol, it never fakes the connect mechanism.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { FakeReceipt } from "../types.ts";
import type { McpFakeRecording, RecordedCall } from "./recording.ts";

export interface McpFakeHandle {
  readonly url: string;
  /** Every call the fake actually received so far, in arrival order —
   * gap 1's `WorldSnapshot.fakeReceipts` reads this through the
   * `fakeReceipts` hook `real-target.ts` folds it into. */
  receipts(): readonly FakeReceipt[];
  stop(): void;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function findRecordedCall(
  recording: McpFakeRecording,
  tool: string,
  args: Record<string, unknown>,
): RecordedCall | undefined {
  const wanted = canonical(args);
  return recording.calls.find(
    (call) => call.tool === tool && canonical(call.arguments) === wanted,
  );
}

function buildServer(
  recording: McpFakeRecording,
  receipts: FakeReceipt[],
): Server {
  const server = new Server(
    { name: `${recording.server}-fake`, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: recording.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const match = findRecordedCall(recording, request.params.name, args);
    if (match === undefined) {
      throw new Error(
        `No recorded call for ${recording.server}.${request.params.name}(${JSON.stringify(args)})`,
      );
    }
    receipts.push({
      server: recording.server,
      toolName: request.params.name,
      arguments: args,
    });
    return match.response;
  });

  return server;
}

/**
 * Starts a fake MCP server over Streamable HTTP on `port` (0 lets the
 * OS pick a free one). A fresh `Server`/transport pair is minted per
 * MCP session, keyed by the `Mcp-Session-Id` header — the same
 * per-session-map pattern `stub-mcp-server.ts` establishes, needed
 * because this SDK's `Server` cannot outlive one `initialize` handshake.
 */
export function startMcpFake(
  recording: McpFakeRecording,
  port = 0,
): McpFakeHandle {
  const receipts: FakeReceipt[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const httpServer = Bun.serve({
    port,
    fetch: async (req) => {
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
      await buildServer(recording, receipts).connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    url: `http://127.0.0.1:${String(httpServer.port)}/mcp`,
    receipts: () => receipts,
    stop: () => httpServer.stop(true),
  };
}
