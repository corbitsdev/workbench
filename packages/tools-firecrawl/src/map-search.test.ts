import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createMapSearchTools, MAP_SEARCH_DEFINITIONS } from "./map-search";
import type { FirecrawlFetch } from "./shared";

type FetchStub = FirecrawlFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("createMapSearchTools", () => {
  it("returns the map and search tools", () => {
    const tools = createMapSearchTools({ apiKey: "test-key" });
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "firecrawl_map",
      "firecrawl_search",
    ]);
  });

  it("exposes both definitions in MAP_SEARCH_DEFINITIONS", () => {
    expect(MAP_SEARCH_DEFINITIONS.map((definition) => definition.name)).toEqual(
      ["firecrawl_map", "firecrawl_search"],
    );
  });

  it("throws when apiKey is empty", () => {
    expect(() => createMapSearchTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("firecrawl_map handler", () => {
  it("maps a site and returns the parsed response", async () => {
    const stubResponse = {
      success: true,
      links: [{ url: "https://example.com/a", title: "A" }],
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createMapSearchTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_map",
        arguments: {
          url: "https://example.com",
          search: "docs",
          sitemapOnly: true,
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/map");
    const body = JSON.parse(String(call?.[1].body));
    expect(body).toEqual({
      url: "https://example.com",
      limit: 5000,
      search: "docs",
      sitemap: "only",
    });
  });

  it("caps the limit at the maximum", async () => {
    const fetcher = makeFetchStub({ success: true, links: [] });
    const runner = createToolRunner(
      createMapSearchTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "firecrawl_map",
        arguments: { url: "https://example.com", limit: 999999 },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body.limit).toBe(100000);
  });
});

describe("firecrawl_search handler", () => {
  it("searches and returns the parsed response", async () => {
    const stubResponse = {
      success: true,
      data: { web: [{ title: "Result", url: "https://example.com" }] },
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createMapSearchTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_search",
        arguments: {
          query: "firecrawl",
          sources: ["web", "news"],
          tbs: "qdr:d",
          scrapeOptions: { formats: ["markdown"] },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/search");
    const body = JSON.parse(String(call?.[1].body));
    expect(body).toEqual({
      query: "firecrawl",
      limit: 10,
      sources: ["web", "news"],
      tbs: "qdr:d",
      scrapeOptions: { formats: ["markdown"] },
    });
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createMapSearchTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_search", arguments: { query: "test" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});
