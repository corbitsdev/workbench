import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createExaTools, EXA_HUB_TOOLS, type ExaFetch } from "./index";

type FetchStub = ExaFetch & {
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

describe("createExaTools", () => {
  it("exposes exa_search and the generic web_search alias", () => {
    const tools = createExaTools({ apiKey: "test-key" });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(["exa_search", "web_search"]);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createExaTools({ apiKey: "" })).toThrow(
      "Exa apiKey is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createExaTools({ apiKey: "test-key", baseUrl: "not-a-url" }),
    ).toThrow("Exa baseUrl must be a valid URL");
  });
});

describe("exa_search handler", () => {
  it("searches with default parameters", async () => {
    const stubResponse = {
      results: [
        {
          title: "Test Result",
          url: "https://example.com",
          publishedDate: "2024-01-01T00:00:00.000Z",
          author: "Test Author",
          text: "Test text",
          summary: "Test summary",
        },
      ],
    };

    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "test query" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([
      {
        url: "https://example.com",
        title: "Test Result",
        publishedAt: "2024-01-01T00:00:00.000Z",
        source: "web",
        engagement: { upvotes: 0, comments: 0 },
        author: "Test Author",
      },
    ]);
  });

  it("tags undated web results degraded and dates them to retrieval time", async () => {
    const fetcher = makeFetchStub({
      results: [{ title: "No date", url: "https://nodate.com" }],
    });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "web_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    const items = JSON.parse(String(result.content));
    expect(items[0].source).toBe("web");
    expect(items[0].provenance).toBe("degraded");
    expect(typeof items[0].publishedAt).toBe("string");
    expect(items[0].publishedAt.length).toBeGreaterThan(0);
  });

  it("respects numResults cap", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "exa_search",
        arguments: { query: "test", numResults: 100 },
      },
      new AbortController().signal,
    );

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1].body));
    expect(body.numResults).toBe(25);
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ message: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "test" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exa API error: 401 Invalid API key");
  });

  it("forwards type and domain filters in the request body", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "exa_search",
        arguments: {
          query: "launches",
          type: "neural",
          includeDomains: ["example.com"],
          excludeDomains: ["spam.com"],
        },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body).toEqual({
      query: "launches",
      numResults: 5,
      type: "neural",
      includeDomains: ["example.com"],
      excludeDomains: ["spam.com"],
    });
  });

  it("drops non-string-array domain filters", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "exa_search",
        arguments: {
          query: "q",
          includeDomains: ["ok", 7],
          excludeDomains: "nope",
        },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body).toEqual({ query: "q", numResults: 5 });
  });

  it("drops empty-string type from the request body", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q", type: "" } },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body).not.toHaveProperty("type");
  });

  it("requires a query argument", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("drops results without a usable url", async () => {
    const fetcher = makeFetchStub({ results: [{ publishedDate: "" }] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([]);
  });

  it("errors when a search result is not an object", async () => {
    const fetcher = makeFetchStub({ results: ["nope"] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Exa response contains an invalid search result",
    );
  });

  it("errors when the response result list is missing", async () => {
    const fetcher = makeFetchStub({ notResults: [] });
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Exa response contains an invalid search result list",
    );
  });

  it("uses the HTTP status text when the error body is empty", async () => {
    const fetcher: ExaFetch = mock(() =>
      Promise.resolve(
        new Response("", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exa API error: 502 Bad Gateway");
  });

  it("surfaces a non-JSON error body verbatim", async () => {
    const fetcher: ExaFetch = mock(() =>
      Promise.resolve(
        new Response("rate limited", { status: 429, statusText: "" }),
      ),
    );
    const runner = createToolRunner(
      createExaTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "exa_search", arguments: { query: "q" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exa API error: 429 rate limited");
  });
});

describe("EXA_HUB_TOOLS", () => {
  it("builds the exa search tool from resolved credentials", () => {
    const entry = EXA_HUB_TOOLS.exa_search;
    expect(entry.providerName).toBe("exa");
    expect(entry.definition.name).toBe("exa_search");

    const tools = entry.createTools({
      apiKey: "k",
      baseURL: "https://api.exa.ai",
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("exa_search");
  });

  it("exposes a web_search alias resolved through the same exa provider", () => {
    const entry = EXA_HUB_TOOLS.web_search;
    expect(entry.providerName).toBe("exa");
    expect(entry.definition.name).toBe("web_search");

    const tools = entry.createTools({
      apiKey: "k",
      baseURL: "https://api.exa.ai",
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("web_search");
  });
});
