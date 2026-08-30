import { expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  callMcpTool,
  listMcpTools,
  MCP_REQUEST_TIMEOUT_MS,
} from "./mcp-client";

test("MCP_REQUEST_TIMEOUT_MS is above the SDK 60s default and under a 5 minute chat turn", () => {
  expect(MCP_REQUEST_TIMEOUT_MS).toBe(2 * 60 * 1000);
});

test("callMcpTool passes the request timeout as callTool options", async () => {
  const options: unknown[] = [];
  const client = {
    callTool: async (
      _params: unknown,
      _schema: unknown,
      requestOptions: unknown,
    ) => {
      options.push(requestOptions);
      return { content: [], isError: false };
    },
  } as unknown as Client;

  await callMcpTool(client, { name: "generate-design", arguments: {} });

  expect(options).toEqual([{ timeout: MCP_REQUEST_TIMEOUT_MS }]);
});

test("listMcpTools passes the request timeout as listTools options", async () => {
  const options: unknown[] = [];
  const client = {
    listTools: async (_params: unknown, requestOptions: unknown) => {
      options.push(requestOptions);
      return { tools: [] };
    },
  } as unknown as Client;

  await listMcpTools(client);

  expect(options).toEqual([{ timeout: MCP_REQUEST_TIMEOUT_MS }]);
});
