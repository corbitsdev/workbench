// End-to-end proof: a connected MCP server (a stub, real wire protocol)
// is discoverable via mcp_list_servers, its tools are discoverable via
// mcp_list_tools (including the per-tool readOnlyHint signal), and
// mcp_call actually invokes the downstream tool and returns its result
// — plus mcp_call's static approval gate, which `toolApprovalEffect`
// (`vendor/intx/agent/src/tool.ts`) reads from this bundle's
// `definitions`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { toolApprovalEffect } from "@intx/agent";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import type { ToolCall } from "@intx/types/runtime";

import {
  MCP_CALL_TOOL,
  MCP_LIST_SERVERS_TOOL,
  MCP_LIST_TOOLS_TOOL,
  MCP_READ_TOOL,
  mcpCredentialHandle,
  mcpTools,
} from "../src/tool";
import type { McpToolsEnv } from "../src/tool";
import {
  startStubMcpServer,
  type StubMcpServerHandle,
} from "./stub-mcp-server";

let stub: StubMcpServerHandle;
const TOKEN = "test-bearer-token";

beforeEach(() => {
  stub = startStubMcpServer({ requiredToken: TOKEN });
});

afterEach(() => {
  stub.stop();
});

/** A fake `credentials` capability shaping the same origin-pinned http
 * handle the real `http` credential provider would, for the single
 * `mcp:notion` handle this scenario connects. */
function fakeCredentials(): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (handle !== mcpCredentialHandle("notion")) {
        return Promise.reject(
          new Error(`no credential is bound to handle "${handle}"`),
        );
      }
      return Promise.resolve({
        kind: "http",
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${TOKEN}`);
          return fetch(input as string | URL, { ...init, headers });
        },
        dispose: () => {},
      });
    },
  };
}

// `registryConfig` (tool.ts) never injects a `fetchImpl` -- it always
// reaches `listMcpServers` through the real global `fetch`, matching
// `@corbits/connections-tools`' own client. Each test that exercises
// list/call therefore stubs `globalThis.fetch` for the duration of the
// test rather than passing one through `McpToolsEnv`.
function fakeEnv(): McpToolsEnv {
  return {
    credentials: fakeCredentials(),
    hubConnectionsUrl: "https://hub.internal",
    sidecarToken: "sidecar-token",
    address: "run-1@workbench",
  } as unknown as McpToolsEnv;
}

function findDeclaration(name: string) {
  const declaration = mcpTools.definitions.find((d) => d.name === name);
  if (declaration === undefined) {
    throw new Error(`no declaration named "${name}" on mcpTools`);
  }
  return declaration;
}

test("mcp_call declares approval: ask, unconditionally", () => {
  const bundle = mcpTools(fakeEnv());
  const callDecl = bundle.definitions.find((d) => d.name === MCP_CALL_TOOL);
  expect(callDecl).toBeDefined();

  expect(toolApprovalEffect(findDeclaration(MCP_CALL_TOOL))).toBe("ask");
  expect(toolApprovalEffect(findDeclaration(MCP_LIST_SERVERS_TOOL))).toBe(
    "allow",
  );
  expect(toolApprovalEffect(findDeclaration(MCP_LIST_TOOLS_TOOL))).toBe(
    "allow",
  );
  expect(toolApprovalEffect(findDeclaration(MCP_READ_TOOL))).toBe("allow");
});

test("mcp_read executes a readOnlyHint tool without approval", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/workflow-connections/mcp-servers")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ slug: "notion", name: "Notion", url: stub.url }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "r1",
        name: MCP_READ_TOOL,
        arguments: { server: "notion", tool: "echo", arguments: { text: "hi" } },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content as string)).toEqual([
      { type: "text", text: "hi" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_read refuses a non-readOnlyHint tool and points to mcp_call, never trusting the model's claim", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/workflow-connections/mcp-servers")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ slug: "notion", name: "Notion", url: stub.url }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "r2",
        name: MCP_READ_TOOL,
        arguments: { server: "notion", tool: "write_note", arguments: {} },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(MCP_CALL_TOOL);
    expect(stub.calls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connect -> list servers -> list tools -> call, end to end", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/workflow-connections/mcp-servers")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ slug: "notion", name: "Notion", url: stub.url }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const bundle = mcpTools(fakeEnv());
    const signal = new AbortController().signal;

    const servers = await bundle.run(
      { id: "c1", name: MCP_LIST_SERVERS_TOOL, arguments: {} },
      signal,
    );
    expect(servers.isError).toBeFalsy();
    expect(JSON.parse(servers.content as string)).toEqual({
      servers: [{ server: "notion", name: "Notion" }],
    });

    const tools = await bundle.run(
      {
        id: "c2",
        name: MCP_LIST_TOOLS_TOOL,
        arguments: { server: "notion" },
      } satisfies ToolCall,
      signal,
    );
    expect(tools.isError).toBeFalsy();
    const toolsBody = JSON.parse(tools.content as string) as {
      server: string;
      tools: { name: string; readOnly: boolean }[];
    };
    expect(toolsBody.server).toBe("notion");
    const byName = Object.fromEntries(
      toolsBody.tools.map((t) => [t.name, t.readOnly]),
    );
    expect(byName["echo"]).toBe(true);
    expect(byName["write_note"]).toBe(false);

    const called = await bundle.run(
      {
        id: "c3",
        name: MCP_CALL_TOOL,
        arguments: {
          server: "notion",
          tool: "echo",
          arguments: { text: "hi" },
        },
      } satisfies ToolCall,
      signal,
    );
    expect(called.isError).toBeFalsy();
    expect(JSON.parse(called.content as string)).toEqual([
      { type: "text", text: "hi" },
    ]);
    expect(stub.calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_call against an unconnected server degrades to an honest error, never a fabricated result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/workflow-connections/mcp-servers")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const bundle = mcpTools(fakeEnv());
    const result = await bundle.run(
      {
        id: "c4",
        name: MCP_CALL_TOOL,
        arguments: { server: "notion", tool: "echo", arguments: {} },
      } satisfies ToolCall,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not connected/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
