import { expect, test } from "bun:test";
import { type } from "arktype";
import { CredentialBinding } from "@intx/types";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import { ToolCredentialHandle } from "@intx/types/package-json";
import type { ToolCall } from "@intx/types/runtime";

import {
  MCP_CALL_TOOL,
  MCP_LIST_SERVERS_TOOL,
  MCP_LIST_TOOLS_TOOL,
  MCP_READ_TOOL,
  mcpCredentialHandle,
  mcpTools,
  readOnlyGate,
} from "./tool";
import type { McpToolsEnv } from "./tool";
import type { McpToolInfo } from "./mcp-client";

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

test("declares four tools: mcp_list_servers, mcp_list_tools, mcp_read, mcp_call", () => {
  const bundle = mcpTools(fakeEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    MCP_LIST_SERVERS_TOOL,
    MCP_LIST_TOOLS_TOOL,
    MCP_READ_TOOL,
    MCP_CALL_TOOL,
  ]);
});

test("readOnlyGate allows a tool the live tools/list marks readOnlyHint: true", () => {
  const tools: readonly McpToolInfo[] = [
    {
      name: "search",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
  ];
  const gate = readOnlyGate(tools, "search");
  expect(gate.allowed).toBe(true);
});

test("readOnlyGate refuses a tool without readOnlyHint, pointing to mcp_call", () => {
  const tools: readonly McpToolInfo[] = [
    { name: "delete_row", inputSchema: {} },
  ];
  const gate = readOnlyGate(tools, "delete_row");
  expect(gate.allowed).toBe(false);
  if (!gate.allowed) {
    expect(gate.reason).toContain(MCP_CALL_TOOL);
  }
});

test("readOnlyGate never trusts a model's claim about a tool it can't find", () => {
  const gate = readOnlyGate([], "made_up_tool");
  expect(gate.allowed).toBe(false);
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
    expect(result.content).toMatch(/not reachable from this run/i);
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

test("mcp_list_tools {server} surfaces the credential resolve reason instead of a bare not-connected", async () => {
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
        id: "c2",
        name: MCP_LIST_TOOLS_TOOL,
        arguments: { server: "notion" },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not reachable from this run/i);
    expect(result.content).toContain("no credential is bound");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcpCredentialHandle mints a handle conforming to @intx/types' ToolCredentialHandle grammar", () => {
  const handle = mcpCredentialHandle("exa");
  expect(handle).toBe("mcp.exa");
  const parsed = ToolCredentialHandle(handle);
  expect(parsed instanceof type.errors).toBe(false);
});

test("a mcp-tools CredentialBinding built on the minted handle parses under @intx/types' CredentialBinding schema", () => {
  const binding = {
    package: "@corbits/mcp-tools",
    handle: mcpCredentialHandle("exa"),
    provider: "mcp:exa",
    locator: "tenant" as const,
  };
  const parsed = CredentialBinding(binding);
  expect(parsed instanceof type.errors).toBe(false);
});

test("mint -> bind -> resolve round trip: mcp_call resolves credentials by the exact handle mcpCredentialHandle mints", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ slug: "exa", name: "Exa", url: "https://example.test/mcp" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  try {
    const boundHandle = mcpCredentialHandle("exa");
    let resolvedWithHandle: string | undefined;
    const capability: CredentialCapability = {
      resolve(handle: string): Promise<MediatedCredential> {
        resolvedWithHandle = handle;
        if (handle !== boundHandle) {
          return Promise.reject(
            new Error(`no credential is bound to handle "${handle}"`),
          );
        }
        return Promise.reject(new Error("server not reachable in this fake"));
      },
    };
    const bundle = mcpTools(fakeEnv(undefined, capability));
    const result = await bundle.run(
      {
        id: "c1",
        name: MCP_CALL_TOOL,
        arguments: { server: "exa", tool: "echo" },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    // The fake rejects even a correctly-resolved handle (no MCP server is
    // actually reachable here); this proves resolve() was called with
    // EXACTLY the handle mcp-credential-bindings.ts mints, not that the
    // call itself succeeds end to end.
    expect(resolvedWithHandle).toBe(boundHandle);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("no credential is bound");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
