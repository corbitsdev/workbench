import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  connectionsTools,
  LIST_CONNECTIONS_TOOL,
  REQUEST_CONNECTION_TOOL,
  type WorkflowConnectionEnv,
} from "./tool";

function testEnv(): WorkflowConnectionEnv {
  return {
    hubConnectionsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowConnectionEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares exactly list_connections and request_connection, neither gated behind approval", () => {
  expect(connectionsTools.definitions).toEqual([
    { name: LIST_CONNECTIONS_TOOL },
    { name: REQUEST_CONNECTION_TOOL },
  ]);
});

test("requires the sanctioned workflow-connection env keys", () => {
  expect(connectionsTools.requires).toEqual([
    "hubConnectionsUrl",
    "sidecarToken",
    "address",
  ]);
});

function stubFetch(opts: {
  connections?: unknown[];
  mcpServers?: unknown[];
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/mcp-servers")) {
      return new Response(JSON.stringify({ data: opts.mcpServers ?? [] }));
    }
    return new Response(JSON.stringify({ data: opts.connections ?? [] }));
  }) as unknown as typeof fetch;
}

test("list_connections summarizes connected and not-connected connectors from the client", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({
    connections: [
      {
        id: "github",
        displayName: "GitHub",
        docsUrl: "https://github.com/settings/tokens",
        connected: true,
      },
      {
        id: "scrapecreators",
        displayName: "ScrapeCreators",
        docsUrl: "https://scrapecreators.com",
        connected: false,
      },
    ],
    mcpServers: [
      { slug: "notion", name: "Notion", url: "https://mcp.notion.example" },
      { slug: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp" },
    ],
  });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_CONNECTIONS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Connected: GitHub/);
    expect(result.content).toMatch(/Exa \(via MCP\)/);
    expect(result.content).toMatch(/Notion \(MCP server\)/);
    expect(result.content).toMatch(/Not connected: [^.]*ScrapeCreators/);
    expect(result.content).toMatch(/Granola/);
    expect(result.content).not.toMatch(/Exa,/); // Exa never listed twice
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list_connections returns an honest error on an unreachable hub, never fabricating success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_CONNECTIONS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection falls back to the Add MCP server deep link for a name that is neither a fixed connector nor a connected MCP server", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ mcpServers: [] });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "attio" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/plugins\?connect=mcp/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection reports an already-connected MCP server rather than re-requesting it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({
    mcpServers: [
      { slug: "notion", name: "Notion", url: "https://mcp.notion.example" },
    ],
  });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "notion" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/already connected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection returns the connector's deep link for a known registry-only connector, performing no HTTP call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("request_connection must never call fetch");
  }) as unknown as typeof fetch;
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "github" }),
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/GitHub/);
    expect(result.content).toContain("/plugins?connect=github");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection deep-links a curated MCP preset by name, checking for an existing MCP connection first", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ mcpServers: [] });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "Exa" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Exa/);
    expect(result.content).toMatch(/no key needed/);
    expect(result.content).toContain("/plugins?connect=mcp:exa");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection reports an already-connected preset rather than re-requesting it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({
    mcpServers: [{ slug: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp" }],
  });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "exa" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/already connected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection rejects a call missing the connector field", async () => {
  const bundle = connectionsTools(testEnv());
  const result = await bundle.run(
    callFor(REQUEST_CONNECTION_TOOL, {}),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("an unknown tool name returns an honest error, never a silent no-op", async () => {
  const bundle = connectionsTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
