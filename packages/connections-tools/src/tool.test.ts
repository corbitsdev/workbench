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
  posted?: unknown[];
  postStatus?: number;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/participants/messages")) {
      opts.posted?.push(JSON.parse(String(init?.body)));
      if (opts.postStatus !== undefined && opts.postStatus !== 201) {
        return new Response(
          JSON.stringify({ error: { message: "no channel" } }),
          { status: opts.postStatus },
        );
      }
      return new Response(
        JSON.stringify({ id: "msg_1", createdAt: "2026-08-20T00:00:00Z" }),
        { status: 201 },
      );
    }
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
      {
        slug: "fieldnotes",
        name: "Fieldnotes",
        url: "https://mcp.fieldnotes.example",
      },
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
    expect(result.content).toMatch(/Fieldnotes \(MCP server\)/);
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

test("request_connection tells the agent to keep helping for a name this workspace can't connect, never sending the human off to add servers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ mcpServers: [] });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "carrier-pigeon" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/can't connect/i);
    expect(result.content).toMatch(/keep helping/i);
    expect(result.content).not.toMatch(/name and URL/);
    // CL-7141: no fake `/plugins?connect=mcp` deep link — there is no
    // generic add-custom-MCP-server card to land on, so the fallback
    // points at the Plugins page's own connector list in plain prose.
    expect(result.content).not.toContain("/plugins?connect=mcp");
    expect(result.content).toMatch(/plugins page/i);
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

test("request_connection posts a connect-service card into the room for a registry connector", async () => {
  const originalFetch = globalThis.fetch;
  const posted: unknown[] = [];
  globalThis.fetch = stubFetch({
    connections: [
      {
        id: "github",
        displayName: "GitHub",
        docsUrl: "https://github.com/settings/tokens",
        connected: false,
      },
    ],
    posted,
  });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, {
        connector: "github",
        reason: "Connect GitHub so I can review this for you.",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/card/i);
    expect(result.content).toMatch(/keep helping/i);
    expect(posted).toHaveLength(1);
    const body = posted[0] as {
      parts: { kind: string; block: { type: string; data: unknown } }[];
    };
    expect(body.parts[0]?.kind).toBe("block");
    expect(body.parts[0]?.block.type).toBe("connect-service");
    expect(body.parts[0]?.block.data).toEqual({
      connectorId: "github",
      displayName: "GitHub",
      reason: "Connect GitHub so I can review this for you.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection reports an already-connected registry connector rather than posting a card", async () => {
  const originalFetch = globalThis.fetch;
  const posted: unknown[] = [];
  globalThis.fetch = stubFetch({
    connections: [
      {
        id: "github",
        displayName: "GitHub",
        docsUrl: "https://github.com/settings/tokens",
        connected: true,
      },
    ],
    posted,
  });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "github" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/already connected/);
    expect(posted).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection posts a connect-service card for a curated MCP preset, defaulting the reason from the preset", async () => {
  const originalFetch = globalThis.fetch;
  const posted: unknown[] = [];
  globalThis.fetch = stubFetch({ mcpServers: [], posted });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "Exa" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/card/i);
    expect(posted).toHaveLength(1);
    const body = posted[0] as {
      parts: { kind: string; block: { type: string; data: unknown } }[];
    };
    const data = body.parts[0]?.block.data as {
      connectorId: string;
      displayName: string;
      reason: string;
    };
    expect(data.connectorId).toBe("exa");
    expect(data.displayName).toBe("Exa");
    expect(data.reason.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request_connection hands over a plain link when the run has no room to post into", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ mcpServers: [], postStatus: 404 });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(REQUEST_CONNECTION_TOOL, { connector: "exa" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
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
