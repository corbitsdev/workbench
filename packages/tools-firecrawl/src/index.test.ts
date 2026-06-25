import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import {
  createFirecrawlTools,
  FIRECRAWL_DEFINITIONS,
  FIRECRAWL_HUB_TOOLS,
  type FirecrawlFetch,
} from "./index";

type FetchStub = FirecrawlFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("createFirecrawlTools", () => {
  it("returns every Firecrawl tool in definition order", () => {
    const tools = createFirecrawlTools({ apiKey: "test-key" });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      FIRECRAWL_DEFINITIONS.map((definition) => definition.name),
    );
  });

  it("throws when apiKey is empty", () => {
    expect(() => createFirecrawlTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("FIRECRAWL_HUB_TOOLS", () => {
  it("registers one hub entry per Firecrawl definition", () => {
    expect(Object.keys(FIRECRAWL_HUB_TOOLS)).toEqual(
      FIRECRAWL_DEFINITIONS.map((definition) => definition.name),
    );
    expect(FIRECRAWL_HUB_TOOLS.firecrawl_scrape?.providerName).toBe(
      "firecrawl",
    );
  });

  it("creates only the requested tool handler", async () => {
    const fetcher = makeFetchStub({
      success: true,
      data: { markdown: "# Example" },
    });
    const tools = FIRECRAWL_HUB_TOOLS.firecrawl_scrape?.createTools({
      apiKey: "test-key",
      baseURL: "https://api.firecrawl.dev/v2",
      fetcher,
    });

    expect(tools?.map((tool) => tool.definition.name)).toEqual([
      "firecrawl_scrape",
    ]);

    const runner = createToolRunner(tools ?? []);
    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_scrape",
        arguments: { url: "https://example.com" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed stored baseURL and uses the hardcoded default", async () => {
    const fetcher = makeFetchStub({
      success: true,
      data: { markdown: "# Example" },
    });
    const tools = FIRECRAWL_HUB_TOOLS.firecrawl_scrape?.createTools({
      apiKey: "test-key",
      baseURL: "api.firecrawl.dev/v2",
      fetcher,
    });

    const runner = createToolRunner(tools ?? []);
    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_scrape",
        arguments: { url: "https://example.com" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const [requestedUrl] = fetcher.mock.calls[0] ?? [];
    expect(requestedUrl).toContain("https://api.firecrawl.dev/v2");
  });
});
