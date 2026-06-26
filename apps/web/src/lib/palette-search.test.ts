/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { searchPaletteEntities } from "./palette-search";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  const captured: { url?: string; signal?: AbortSignal } = {};
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    captured.url = url;
    captured.signal = init?.signal ?? undefined;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return captured;
}

describe("searchPaletteEntities", () => {
  it("requests the tenant-scoped search url with q and page and parses the response", async () => {
    const captured = stubFetch(200, {
      results: [
        {
          id: "artifact:a1",
          category: "artifact",
          title: "Pricing one-pager",
          to: "/artifacts/a1",
        },
      ],
      page: 1,
      hasMore: true,
    });

    const result = await searchPaletteEntities("tn-1", "pricing", 1);

    expect(captured.url).toContain("/api/tenants/tn-1/search");
    expect(captured.url).toContain("q=pricing");
    expect(captured.url).toContain("page=1");
    expect(result.hasMore).toBe(true);
    expect(result.results[0]!.id).toBe("artifact:a1");
  });

  it("throws on a non-ok response", async () => {
    stubFetch(500, { error: "Search failed" });
    await expect(searchPaletteEntities("tn-1", "x", 0)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("rejects a malformed payload at the boundary", async () => {
    stubFetch(200, { results: [{ id: 1 }], page: 0, hasMore: false });
    await expect(searchPaletteEntities("tn-1", "x", 0)).rejects.toThrow(
      /Unexpected search response/,
    );
  });
});
