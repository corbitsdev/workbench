// Tests for the `mcp-streamable-http` provider: Bearer for a real token,
// NO authorization header at all for the keyless sentinel (a public MCP
// server like Exa accepts an absent header but 401s a bogus bearer), and
// the same origin-pinning + manual-redirect protections its sibling
// providers enforce.
import { describe, expect, test } from "bun:test";
import type { CredentialShapeContext } from "@intx/types";

import {
  createMcpStreamableHttpCredentialProvider,
  MCP_NO_TOKEN_SENTINEL,
  MCP_STREAMABLE_HTTP_PROVIDER_KEY,
} from "./mcp-streamable-http-provider";

function contextWith(secret: string): CredentialShapeContext {
  return {
    origin: "https://mcp.example.test/mcp",
    readCurrentMaterial: () => ({ secret }),
  } as CredentialShapeContext;
}

function capturingFetch() {
  const seen: { url: string; headers: Headers; redirect?: string }[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (input instanceof Request) {
      seen.push({
        url: input.url,
        headers: new Headers(input.headers),
        ...(input.redirect !== undefined ? { redirect: input.redirect } : {}),
      });
    } else {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
      });
    }
    return new Response("ok");
  };
  return { seen, fetchImpl };
}

describe(MCP_STREAMABLE_HTTP_PROVIDER_KEY, () => {
  test("a real token is sent as a Bearer authorization header", async () => {
    const { seen, fetchImpl } = capturingFetch();
    const provider = createMcpStreamableHttpCredentialProvider({
      fetch: fetchImpl,
    });
    const shaped = provider.shape(contextWith("tok-123"));
    if (shaped.kind !== "http") throw new Error("expected http");
    await shaped.fetch("https://mcp.example.test/mcp");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok-123");
  });

  test("the keyless sentinel sends NO authorization header", async () => {
    const { seen, fetchImpl } = capturingFetch();
    const provider = createMcpStreamableHttpCredentialProvider({
      fetch: fetchImpl,
    });
    const shaped = provider.shape(contextWith(MCP_NO_TOKEN_SENTINEL));
    if (shaped.kind !== "http") throw new Error("expected http");
    await shaped.fetch("https://mcp.example.test/mcp");
    expect(seen[0]?.headers.has("authorization")).toBe(false);
    expect(seen[0]?.redirect).toBe("manual");
  });

  test("a cross-origin request is refused before any fetch", async () => {
    const { seen, fetchImpl } = capturingFetch();
    const provider = createMcpStreamableHttpCredentialProvider({
      fetch: fetchImpl,
    });
    const shaped = provider.shape(contextWith("tok-123"));
    if (shaped.kind !== "http") throw new Error("expected http");
    await expect(shaped.fetch("https://evil.example/steal")).rejects.toThrow(
      /pinned to/,
    );
    expect(seen).toHaveLength(0);
  });

  test("a Request input keeps its headers and gains the bearer", async () => {
    const { seen, fetchImpl } = capturingFetch();
    const provider = createMcpStreamableHttpCredentialProvider({
      fetch: fetchImpl,
    });
    const shaped = provider.shape(contextWith("tok-9"));
    if (shaped.kind !== "http") throw new Error("expected http");
    await shaped.fetch(
      new Request("https://mcp.example.test/mcp", {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok-9");
  });
});
