import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createUsageTools, USAGE_DEFINITIONS } from "./usage";
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

describe("createUsageTools", () => {
  it("returns the usage tools", () => {
    const tools = createUsageTools({ apiKey: "test-key" });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      USAGE_DEFINITIONS.map((definition) => definition.name),
    );
  });
});

describe("firecrawl_credit_usage handler", () => {
  it("gets current credit usage", async () => {
    const fetcher = makeFetchStub({
      success: true,
      credits: { used: 100, remaining: 400 },
    });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_credit_usage", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    expect(call?.[1].method).toBe("GET");
  });
});

describe("firecrawl_historical_credit_usage handler", () => {
  it("gets historical credit usage with byApiKey", async () => {
    const fetcher = makeFetchStub({ success: true, data: [] });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_historical_credit_usage",
        arguments: { byApiKey: true },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.firecrawl.dev/v2/team/credit-usage/historical?byApiKey=true",
    );
  });
});

describe("firecrawl_token_usage handler", () => {
  it("gets current token usage", async () => {
    const fetcher = makeFetchStub({ success: true, tokens: { used: 1000 } });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_token_usage", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/team/token-usage");
    expect(call?.[1].method).toBe("GET");
  });
});

describe("firecrawl_historical_token_usage handler", () => {
  it("gets historical token usage", async () => {
    const fetcher = makeFetchStub({ success: true, data: [] });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_historical_token_usage", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.firecrawl.dev/v2/team/token-usage/historical",
    );
    expect(call?.[1].method).toBe("GET");
  });
});

describe("firecrawl_activity handler", () => {
  it("gets team activity with filters", async () => {
    const fetcher = makeFetchStub({ success: true, activities: [] });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_activity",
        arguments: { endpoint: "scrape", limit: 10, cursor: "abc123" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.firecrawl.dev/v2/team/activity?endpoint=scrape&limit=10&cursor=abc123",
    );
    expect(call?.[1].method).toBe("GET");
  });

  it("gets team activity without filters", async () => {
    const fetcher = makeFetchStub({ success: true, activities: [] });
    const runner = createToolRunner(
      createUsageTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_activity", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/team/activity");
    expect(call?.[1].method).toBe("GET");
  });
});
