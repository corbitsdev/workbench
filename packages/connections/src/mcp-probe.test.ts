// Exercises `probeMcpServer` against real HTTP servers on loopback ports
// (never the real network) — a real MCP server, a plain 401 with no OAuth
// metadata behind it, and a 401 that does advertise RFC 9728/8414 metadata
// (the OAuth-gated shape this probe is meant to recognize). Unpinned fetch
// follows a 302 to another origin; the probe must not.
import { describe, expect, test } from "bun:test";
import { probeMcpServer } from "./mcp-probe";

function startUnauthorizedServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  return {
    url: `http://localhost:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
}

function startOAuthGatedServer(): { url: string; stop: () => void } {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `http://localhost:${server.port}/mcp`,
          authorization_servers: [`http://localhost:${server.port}`],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const issuer = `http://localhost:${server.port}`;
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
        });
      }
      return new Response("unauthorized", { status: 401 });
    },
  });
  return {
    url: `http://localhost:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
}

describe("probeMcpServer", () => {
  test("rejects an unparseable URL without throwing", async () => {
    const result = await probeMcpServer("not a url", undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects a non-http(s) URL", async () => {
    const result = await probeMcpServer("ftp://example.com", undefined);
    expect(result).toEqual({
      ok: false,
      message: "The MCP server URL must be http or https.",
    });
  });

  test("a plain 401 with no discoverable OAuth metadata reports a plain failure", async () => {
    const stub = startUnauthorizedServer();
    try {
      const result = await probeMcpServer(stub.url, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.requiresOAuth).toBeUndefined();
    } finally {
      stub.stop();
    }
  });

  test("a 401 backed by RFC 9728/8414 metadata reports requiresOAuth with the discovered authorization server", async () => {
    const stub = startOAuthGatedServer();
    try {
      const result = await probeMcpServer(stub.url, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok && result.requiresOAuth) {
        expect(result.authorizationServerUrl).toBe(new URL(stub.url).origin);
      } else {
        throw new Error("expected requiresOAuth: true");
      }
    } finally {
      stub.stop();
    }
  });

  test("a 302 to another origin does not succeed", async () => {
    let destinationHits = 0;
    const destination = Bun.serve({
      hostname: "localhost",
      port: 0,
      fetch: () => {
        destinationHits += 1;
        return new Response("ok");
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: `http://localhost:${String(destination.port)}/mcp`,
          },
        }),
    });
    try {
      const result = await probeMcpServer(
        `http://127.0.0.1:${String(redirector.port)}/mcp`,
        undefined,
      );
      expect(result.ok).toBe(false);
      expect(destinationHits).toBe(0);
    } finally {
      redirector.stop(true);
      destination.stop(true);
    }
  });
});
