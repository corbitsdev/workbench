import { expect, test } from "bun:test";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import type { ToolCall } from "@intx/types/runtime";

import {
  MCP_CALL_TOOL,
  MCP_LIST_SERVERS_TOOL,
  MCP_LIST_TOOLS_TOOL,
  mcpTools,
} from "./tool";
import type { McpToolsEnv } from "./tool";

function fakeEnv(
  overrides?: Partial<McpToolsEnv>,
  credentials?: CredentialCapability,
): McpToolsEnv {
  return {
    credentials,
    hubConnectionsUrl: "https://hub.internal",
    sidecarToken: "sidecar-token",
    address: "run-1@workbench",
    ...overrides,
  } as unknown as McpToolsEnv;
}

test("declares three tools: mcp_list_servers, mcp_list_tools, mcp_call", () => {
  const bundle = mcpTools(fakeEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    MCP_LIST_SERVERS_TOOL,
    MCP_LIST_TOOLS_TOOL,
    MCP_CALL_TOOL,
  ]);
});

test("mcp_list_servers degrades to an honest error when the hub is unreachable, never a fabricated empty list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new Error("network down"))) as unknown as typeof fetch;
  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "c1",
        name: MCP_LIST_SERVERS_TOOL,
        arguments: {},
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("network down");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_list_servers reports no servers plainly when none are connected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "c1",
        name: MCP_LIST_SERVERS_TOOL,
        arguments: {},
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no mcp servers/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_list_tools with no arguments returns a catalog of connected servers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "c1",
        name: MCP_LIST_TOOLS_TOOL,
        arguments: {},
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string)).toEqual({ servers: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_list_tools rejects toolName without server", async () => {
  const bundle = mcpTools(fakeEnv());
  const result = await bundle.run(
    {
      id: "c1",
      name: MCP_LIST_TOOLS_TOOL,
      arguments: { toolName: "echo" },
    } satisfies ToolCall,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
});

test("mcp_call rejects a missing tool argument", async () => {
  const bundle = mcpTools(fakeEnv());
  const result = await bundle.run(
    {
      id: "c1",
      name: MCP_CALL_TOOL,
      arguments: { server: "notion" },
    } satisfies ToolCall,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("tool");
});

test("mcp_call against a server with no bound credential degrades honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { slug: "notion", name: "Notion", url: "https://example.test/mcp" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  try {
    const capability: CredentialCapability = {
      resolve(): Promise<MediatedCredential> {
        return Promise.reject(new Error("no credential is bound"));
      },
    };
    const bundle = mcpTools(fakeEnv(undefined, capability));
    const result = await bundle.run(
      {
        id: "c1",
        name: MCP_CALL_TOOL,
        arguments: { server: "notion", tool: "echo" },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not connected/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown tool name returns a loud error, never silently a no-op", async () => {
  const bundle = mcpTools(fakeEnv());
  const result = await bundle.run(
    { id: "c1", name: "not_a_real_tool", arguments: {} } satisfies ToolCall,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/i);
});
