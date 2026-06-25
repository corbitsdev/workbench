import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { CRAWL_DEFINITIONS, createCrawlTools } from "./crawl";
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

describe("createCrawlTools", () => {
  it("returns one tool per crawl definition with matching names", () => {
    const tools = createCrawlTools({ apiKey: "test-key" });
    expect(tools).toHaveLength(CRAWL_DEFINITIONS.length);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "firecrawl_crawl_start",
      "firecrawl_crawl_status",
      "firecrawl_crawl_active",
      "firecrawl_crawl_errors",
      "firecrawl_crawl_cancel",
      "firecrawl_crawl_params_preview",
    ]);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createCrawlTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("firecrawl_crawl_start handler", () => {
  it("posts to /crawl with mapped body and parses the response", async () => {
    const stubResponse = {
      success: true,
      id: "job_1",
      url: "https://example.com",
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createCrawlTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_crawl_start",
        arguments: {
          url: "https://example.com",
          limit: 25,
          maxDepth: 3,
          includePaths: ["/blog"],
          allowBackwardLinks: true,
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/crawl");
    expect(call?.[1].method).toBe("POST");
    const body = JSON.parse(String(call?.[1].body));
    expect(body).toEqual({
      url: "https://example.com",
      limit: 25,
      maxDiscoveryDepth: 3,
      includePaths: ["/blog"],
      crawlEntireDomain: true,
    });
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Unauthorized" }, 401);
    const runner = createToolRunner(
      createCrawlTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_crawl_start",
        arguments: { url: "https://example.com" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});

describe("firecrawl_crawl_status handler", () => {
  it("gets /crawl/{id} and parses the response", async () => {
    const stubResponse = {
      status: "completed",
      total: 1,
      completed: 1,
      data: [],
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createCrawlTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_crawl_status",
        arguments: { id: "job 1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/crawl/job%201");
    expect(call?.[1].method).toBe("GET");
  });
});

describe("firecrawl_crawl_cancel handler", () => {
  it("deletes /crawl/{id} and parses the response", async () => {
    const stubResponse = { status: "cancelled" };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createCrawlTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_crawl_cancel",
        arguments: { id: "job_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/crawl/job_1");
    expect(call?.[1].method).toBe("DELETE");
  });

  it("errors when id is missing", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createCrawlTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_crawl_cancel", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("id must be a string");
  });
});
