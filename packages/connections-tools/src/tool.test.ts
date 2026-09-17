import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { createConnectorRegistry } from "@corbits/connections/registry";
import type { McpPreset } from "@corbits/connections/mcp-presets";

import {
  connectionsTools,
  LIST_CONNECTIONS_TOOL,
  REQUEST_CONNECTION_TOOL,
  type WorkflowConnectionEnv,
} from "./tool";

// A minimal registry/preset fixture, standing in for whatever connector
// set the deploying build actually wires (e.g. Workbench's own
// `@corbits/connections/registry` `CONNECTOR_REGISTRY`) — this package
// carries no default of its own, so its tests exercise the lookup logic
// against a small stand-in.
const TEST_CONNECTOR_REGISTRY = createConnectorRegistry({
  github: {
    id: "github",
    credentialPlugin: "http",
    displayName: "GitHub",
    authKind: "api-key",
    docsUrl: "https://github.com/settings/tokens",
    feedsTools: ["@corbits/github-tools"],
    probe: async () => ({ ok: true }),
  },
});

const TEST_MCP_PRESETS: readonly McpPreset[] = [
  {
    slug: "granola",
    displayName: "Granola",
    description: "Search meeting notes, transcripts, and action items.",
    url: "https://mcp.granola.ai/mcp",
    connectionMode: "oauth",
    docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
    nativeConnectorId: "granola",
  },
  {
    slug: "exa",
    displayName: "Exa",
    description: "Search and research the live web.",
    url: "https://mcp.exa.ai/mcp",
    connectionMode: "keyless",
    docsUrl: "https://docs.exa.ai/reference/exa-mcp",
    nativeConnectorId: "exa",
  },
  {
    slug: "notion",
    displayName: "Notion",
    description: "Search and update pages, databases, and workspace content.",
    url: "https://mcp.notion.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
];

function testEnv(): WorkflowConnectionEnv {
  return {
    hubConnectionsUrl: "https://hub.example.com",
    tenantId: "ten_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    connectorRegistry: TEST_CONNECTOR_REGISTRY,
    mcpPresets: TEST_MCP_PRESETS,
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
    "tenantId",
    "sidecarToken",
    "address",
  ]);
});

/** Serves the stock tenant provider + credential routes, reporting every
 * connector id in `live` as having an active credential. */
function stubFetch(opts: {
  live?: string[];
  posted?: unknown[];
  postStatus?: number;
}): typeof fetch {
  const live = opts.live ?? [];
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
    if (url.includes("/providers")) {
      return Response.json({
        data: live.map((name) => ({ id: `prv_${name}`, name })),
        nextCursor: null,
      });
    }
    return Response.json({
      data: live.map((name) => ({
        id: `crd_${name}`,
        providerId: `prv_${name}`,
        status: "active",
      })),
      nextCursor: null,
    });
  }) as unknown as typeof fetch;
}

test("list_connections summarizes connected and not-connected connectors from the stock routes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ live: ["github", "exa"] });
  try {
    const bundle = connectionsTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_CONNECTIONS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/Connected: GitHub/);
    expect(result.content).toMatch(/Connected: [^.]*Exa/);
    expect(result.content).toMatch(/Not connected: [^.]*Granola/);
    expect(result.content).toMatch(/Not connected: [^.]*Notion/);
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
  globalThis.fetch = stubFetch({});
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

test("request_connection posts a connect-service card into the room for a registry connector", async () => {
  const originalFetch = globalThis.fetch;
  const posted: unknown[] = [];
  globalThis.fetch = stubFetch({ posted });
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
  globalThis.fetch = stubFetch({ live: ["github"], posted });
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
  globalThis.fetch = stubFetch({ posted });
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
  globalThis.fetch = stubFetch({ postStatus: 404 });
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
  globalThis.fetch = stubFetch({ live: ["exa"] });
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
