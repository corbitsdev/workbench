import { afterEach, describe, expect, test } from "bun:test";
import {
  McpServersApiError,
  connectMcpServer,
  listMcpServers,
  mcpOAuthStartPath,
  mcpOAuthStartPathForServer,
} from "./mcp-servers-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(response: Response) {
  globalThis.fetch = (() =>
    Promise.resolve(response)) as unknown as typeof fetch;
}

describe("mcpOAuthStartPath", () => {
  test("names a curated preset's fixed slug with no query string", () => {
    expect(mcpOAuthStartPath("t1", "granola")).toBe(
      "/api/tenants/t1/mcp-servers/oauth/granola/start",
    );
  });

  test("carries the full ad hoc url and name as query params", () => {
    const path = mcpOAuthStartPath("t1", "acme", {
      name: "Acme",
      url: "https://acme.example.com/mcp",
    });
    expect(path).toBe(
      "/api/tenants/t1/mcp-servers/oauth/acme/start?url=https%3A%2F%2Facme.example.com%2Fmcp&name=Acme",
    );
  });
});

describe("mcpOAuthStartPathForServer", () => {
  test("derives a path-safe slug from a hand-typed name", () => {
    const path = mcpOAuthStartPathForServer(
      "t1",
      "Acme Corp!",
      "https://acme.example.com/mcp",
    );
    expect(path).toContain("/oauth/acme-corp/start?");
    expect(path).toContain("name=Acme+Corp%21");
  });
});

describe("listMcpServers", () => {
  test("resolves the connected server list", async () => {
    stubFetch(
      Response.json({
        data: [
          { slug: "acme", name: "Acme", url: "https://acme.example.com/mcp" },
        ],
      }),
    );
    const servers = await listMcpServers("t1");
    expect(servers).toEqual([
      { slug: "acme", name: "Acme", url: "https://acme.example.com/mcp" },
    ]);
  });

  test("surfaces an honest error message and code from the envelope", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ error: { message: "nope", code: "forbidden" } }),
        { status: 403 },
      ),
    );
    await expect(listMcpServers("t1")).rejects.toMatchObject({
      message: "nope",
      code: "forbidden",
    });
  });
});

describe("connectMcpServer", () => {
  test("returns the connected server on success", async () => {
    stubFetch(
      Response.json({
        slug: "acme",
        name: "Acme",
        url: "https://acme.example.com/mcp",
        toolCount: 3,
      }),
    );
    const result = await connectMcpServer("t1", {
      name: "Acme",
      url: "https://acme.example.com/mcp",
      token: undefined,
    });
    expect(result.toolCount).toBe(3);
  });

  test("a probe failure surfaces the server's honest message, not a fake success", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: {
            message: "Could not connect to that MCP server.",
            code: "connect_failed",
          },
        }),
        { status: 422 },
      ),
    );
    await expect(
      connectMcpServer("t1", {
        name: "Bad",
        url: "https://not-mcp.example.com",
        token: undefined,
      }),
    ).rejects.toBeInstanceOf(McpServersApiError);
  });

  test("an OAuth-gated server surfaces the oauth_required code so the caller can redirect", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: { message: "requires OAuth", code: "oauth_required" },
        }),
        { status: 422 },
      ),
    );
    try {
      await connectMcpServer("t1", {
        name: "Gated",
        url: "https://gated.example.com/mcp",
        token: undefined,
      });
      throw new Error("expected connectMcpServer to reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(McpServersApiError);
      expect((cause as McpServersApiError).code).toBe("oauth_required");
    }
  });
});
