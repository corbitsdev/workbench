import { describe, expect, mock, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { type } from "arktype";
import { ResearchItem } from "@workbench/last30days-core";
import { createHackerNewsTools, type HNFetch } from "./tools";

function makeFetchStub(response: unknown, status = 200): HNFetch {
  return mock((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

const mockHits = [
  {
    objectID: "12345",
    title: "Show HN: Something cool",
    url: "https://example.com/cool",
    points: 100,
    num_comments: 30,
    created_at_i: Math.floor(Date.now() / 1000) - 86400,
  },
  {
    objectID: "67890",
    title: "Ask HN: What do you think?",
    url: null,
    points: 50,
    num_comments: 120,
    created_at_i: Math.floor(Date.now() / 1000) - 172800,
  },
];

describe("hackernews_search tool", () => {
  test("returns normalized ResearchItems on success", async () => {
    const fetcher = makeFetchStub({ hits: mockHits });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "hackernews_search", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items: unknown = JSON.parse(String(result.content));
    expect(Array.isArray(items)).toBe(true);
    const arr = items as unknown[];
    expect(arr).toHaveLength(2);

    for (const item of arr) {
      const validation = ResearchItem(item);
      expect(validation instanceof type.errors).toBe(false);
    }

    const first = arr[0] as Record<string, unknown>;
    expect(first.source).toBe("hn");
  });

  test("falls back to HN URL when item url is null", async () => {
    const fetcher = makeFetchStub({ hits: [mockHits[1]] });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "hackernews_search", arguments: { query: "test" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    const item = items[0] as Record<string, unknown>;
    expect(item.url).toBe("https://news.ycombinator.com/item?id=67890");
  });

  test("returns empty array when hits is empty", async () => {
    const fetcher = makeFetchStub({ hits: [] });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    const result = await runner.run(
      {
        id: "call_1",
        name: "hackernews_search",
        arguments: { query: "obscure" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test("surfaces HTTP errors as tool errors", async () => {
    const fetcher: HNFetch = mock(() =>
      Promise.resolve(
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      ),
    );
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "hackernews_search", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("HN API error: 403");
  });

  test("defaults hitsPerPage to 10", async () => {
    let captured = "";
    const fetcher: HNFetch = mock((url: string) => {
      captured = url;
      return Promise.resolve(
        new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    await runner.run(
      { id: "call_1", name: "hackernews_search", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(new URL(captured).searchParams.get("hitsPerPage")).toBe("10");
  });

  test("forwards an explicit limit", async () => {
    let captured = "";
    const fetcher: HNFetch = mock((url: string) => {
      captured = url;
      return Promise.resolve(
        new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    await runner.run(
      {
        id: "call_1",
        name: "hackernews_search",
        arguments: { query: "AI", limit: 25 },
      },
      new AbortController().signal,
    );

    expect(new URL(captured).searchParams.get("hitsPerPage")).toBe("25");
  });

  test("clamps a limit over the max to 50", async () => {
    let captured = "";
    const fetcher: HNFetch = mock((url: string) => {
      captured = url;
      return Promise.resolve(
        new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    await runner.run(
      {
        id: "call_1",
        name: "hackernews_search",
        arguments: { query: "AI", limit: 999 },
      },
      new AbortController().signal,
    );

    expect(new URL(captured).searchParams.get("hitsPerPage")).toBe("50");
  });

  test("surfaces missing query as tool error", async () => {
    const fetcher = makeFetchStub({ hits: [] });
    const runner = createToolRunner(createHackerNewsTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "hackernews_search", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("query is required");
  });
});
