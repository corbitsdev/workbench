import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createExtractTools, EXTRACT_DEFINITIONS } from "./extract";
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

describe("createExtractTools", () => {
  it("returns the start and status tools", () => {
    const tools = createExtractTools({ apiKey: "test-key" });
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "firecrawl_extract_start",
      "firecrawl_extract_status",
    ]);
  });

  it("exposes both definitions in EXTRACT_DEFINITIONS", () => {
    expect(EXTRACT_DEFINITIONS.map((def) => def.name)).toEqual([
      "firecrawl_extract_start",
      "firecrawl_extract_status",
    ]);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createExtractTools({ apiKey: "" })).toThrow(
      "Firecrawl apiKey is required",
    );
  });
});

describe("firecrawl_extract_start handler", () => {
  it("posts urls and schema and returns the job id", async () => {
    const stubResponse = { success: true, id: "job-123", invalidURLs: null };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createExtractTools({ apiKey: "test-key", fetcher }),
    );

    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
    };
    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_extract_start",
        arguments: {
          urls: ["https://example.com"],
          prompt: "Extract the title",
          schema,
          enableWebSearch: true,
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toContain("/v2/extract");
    expect(call?.[1].method).toBe("POST");
    const body = JSON.parse(String(call?.[1].body));
    expect(body.urls).toEqual(["https://example.com"]);
    expect(body.schema).toEqual(schema);
    expect(body.prompt).toBe("Extract the title");
    expect(body.enableWebSearch).toBe(true);
  });

  it("requires a non-empty urls array", async () => {
    const fetcher = makeFetchStub({ success: true, id: "job-1" });
    const runner = createToolRunner(
      createExtractTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_extract_start",
        arguments: { urls: [] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("urls must be non-empty");
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createExtractTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_extract_start",
        arguments: { urls: ["https://example.com"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});

describe("firecrawl_extract_status handler", () => {
  it("gets the job status by id", async () => {
    const stubResponse = {
      success: true,
      status: "completed",
      data: { title: "Example" },
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createExtractTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_extract_status",
        arguments: { id: "job-123" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toContain("/v2/extract/job-123");
    expect(call?.[1].method).toBe("GET");
  });

  it("requires an id", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createExtractTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_extract_status", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("id must be a string");
  });
});
