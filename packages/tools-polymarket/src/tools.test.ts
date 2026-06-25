import { describe, expect, mock, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { type } from "arktype";
import { ResearchItem } from "@workbench/last30days-core";
import { createPolymarketTools, type PolymarketFetch } from "./tools";

const mockMarketsResponse = [
  {
    id: "market-1",
    question: "Will Bitcoin hit $200k in 2026?",
    outcomePrices: ["0.4", "0.6"],
    volume24hr: 50000,
    endDate: "2026-12-31T00:00:00Z",
    conditionId: "cond-btc-200k",
  },
  {
    id: "market-2",
    question: "Will GPT-5 launch in Q1 2026?",
    outcomePrices: ["0.7", "0.3"],
    volume24hr: 30000,
    endDate: "2026-03-31T00:00:00Z",
    conditionId: "cond-gpt5-q1",
  },
];

function makeFetchStub(response: unknown, status = 200): PolymarketFetch {
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

describe("polymarket_odds tool", () => {
  test("returns normalized ResearchItems on success", async () => {
    const fetcher = makeFetchStub(mockMarketsResponse);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "polymarket_odds", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(2);

    for (const item of items) {
      const validation = ResearchItem(item);
      expect(validation instanceof type.errors).toBe(false);
    }

    const first = items[0] as Record<string, unknown>;
    expect(first.source).toBe("polymarket");
    expect(first.entityTag).toBe("cond-btc-200k");
  });

  test("sends default limit of 10 when none provided", async () => {
    const fetcher = makeFetchStub(mockMarketsResponse);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    await runner.run(
      { id: "call_1", name: "polymarket_odds", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const firstCall = (fetcher as ReturnType<typeof mock>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const calledUrl = new URL(firstCall![0] as string);
    expect(calledUrl.searchParams.get("limit")).toBe("10");
  });

  test("forwards an explicit limit", async () => {
    const fetcher = makeFetchStub(mockMarketsResponse);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    await runner.run(
      {
        id: "call_1",
        name: "polymarket_odds",
        arguments: { query: "AI", limit: 5 },
      },
      new AbortController().signal,
    );

    const firstCall = (fetcher as ReturnType<typeof mock>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const calledUrl = new URL(firstCall![0] as string);
    expect(calledUrl.searchParams.get("limit")).toBe("5");
  });

  test("clamps limit above the max to 50", async () => {
    const fetcher = makeFetchStub(mockMarketsResponse);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    await runner.run(
      {
        id: "call_1",
        name: "polymarket_odds",
        arguments: { query: "AI", limit: 999 },
      },
      new AbortController().signal,
    );

    const firstCall = (fetcher as ReturnType<typeof mock>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const calledUrl = new URL(firstCall![0] as string);
    expect(calledUrl.searchParams.get("limit")).toBe("50");
  });

  test("returns empty array when response is empty", async () => {
    const fetcher = makeFetchStub([]);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    const result = await runner.run(
      {
        id: "call_1",
        name: "polymarket_odds",
        arguments: { query: "obscure" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test("surfaces HTTP error as tool error", async () => {
    const fetcher: PolymarketFetch = mock(() =>
      Promise.resolve(
        new Response("Service Unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      ),
    );
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "polymarket_odds", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Polymarket API error: 503");
  });

  test("surfaces missing query as tool error", async () => {
    const fetcher = makeFetchStub([]);
    const runner = createToolRunner(createPolymarketTools({ fetcher }));

    const result = await runner.run(
      { id: "call_1", name: "polymarket_odds", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("query is required");
  });
});
