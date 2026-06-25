import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createParseTools, PARSE_DEFINITIONS } from "./parse";
import type { FirecrawlFetch } from "./shared";

type FetchStub = FirecrawlFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(parseResponse: unknown, status = 200): FetchStub {
  return mock((input: string, _init: RequestInit) => {
    if (String(input).includes("/parse")) {
      return Promise.resolve(
        new Response(JSON.stringify(parseResponse), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    // First call: return a file blob
    return Promise.resolve(
      new Response(new Blob(["PDF content"]), { status: 200 }),
    );
  });
}

describe("createParseTools", () => {
  it("returns the parse tool", () => {
    const tools = createParseTools({ apiKey: "test-key" });
    expect(tools.map((tool) => tool.definition.name)).toEqual(
      PARSE_DEFINITIONS.map((definition) => definition.name),
    );
  });

  it("throws when apiKey is empty", () => {
    expect(() => createParseTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("firecrawl_parse handler", () => {
  it("downloads a document and parses it", async () => {
    const parseResponse = {
      success: true,
      data: { markdown: "# Parsed Title" },
    };
    const fetcher = makeFetchStub(parseResponse);
    const runner = createToolRunner(
      createParseTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_parse",
        arguments: {
          url: "https://example.com/document.pdf",
          options: { formats: ["markdown"] },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(parseResponse);

    const calls = fetcher.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("https://example.com/document.pdf");
    expect(calls[1]?.[0]).toBe("https://api.firecrawl.dev/v2/parse");
    expect(calls[1]?.[1].method).toBe("POST");
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createParseTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_parse",
        arguments: { url: "https://example.com/doc.pdf" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});
