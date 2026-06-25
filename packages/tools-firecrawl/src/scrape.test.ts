import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createScrapeTools } from "./scrape";
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

describe("createScrapeTools", () => {
  it("returns one tool with the expected definition name", () => {
    const tools = createScrapeTools({ apiKey: "test-key" });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("firecrawl_scrape");
  });

  it("throws when apiKey is empty", () => {
    expect(() => createScrapeTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("firecrawl_scrape handler", () => {
  it("scrapes a URL and returns the parsed result", async () => {
    const stubResponse = {
      success: true,
      data: {
        markdown: "# Example",
        metadata: {
          title: "Example",
          sourceURL: "https://example.com",
          statusCode: 200,
        },
      },
    };

    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createScrapeTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_scrape",
        arguments: {
          url: "https://example.com",
          formats: ["markdown"],
          onlyMainContent: true,
          waitFor: 500,
          jsonOptions: { prompt: "extract title" },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(call?.[1].method).toBe("POST");
    const body = JSON.parse(String(call?.[1].body));
    expect(body).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 500,
      jsonOptions: { prompt: "extract title" },
    });
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createScrapeTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_scrape",
        arguments: { url: "https://example.com" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});
