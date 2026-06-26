import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import {
  BATCH_SCRAPE_DEFINITIONS,
  createBatchScrapeTools,
} from "./batch-scrape";
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

describe("createBatchScrapeTools", () => {
  it("returns the batch scrape tools", () => {
    const tools = createBatchScrapeTools({ apiKey: "test-key" });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      BATCH_SCRAPE_DEFINITIONS.map((definition) => definition.name),
    );
  });
});

describe("firecrawl_batch_scrape_start handler", () => {
  it("starts a batch scrape job", async () => {
    const fetcher = makeFetchStub({ success: true, id: "batch_1" });
    const runner = createToolRunner(
      createBatchScrapeTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_batch_scrape_start",
        arguments: {
          urls: ["https://example.com/a", "https://example.com/b"],
          scrapeOptions: { formats: ["markdown"] },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      success: true,
      id: "batch_1",
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/batch/scrape");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      urls: ["https://example.com/a", "https://example.com/b"],
      formats: ["markdown"],
    });
  });

  it("requires a non-empty urls array", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createBatchScrapeTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_batch_scrape_start",
        arguments: { urls: [] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("urls must be non-empty");
  });
});

describe("firecrawl_batch_scrape_status handler", () => {
  it("gets batch scrape status by id", async () => {
    const fetcher = makeFetchStub({ status: "completed", data: [] });
    const runner = createToolRunner(
      createBatchScrapeTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_batch_scrape_status",
        arguments: { id: "batch 1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.firecrawl.dev/v2/batch/scrape/batch%201",
    );
    expect(call?.[1].method).toBe("GET");
  });
});
