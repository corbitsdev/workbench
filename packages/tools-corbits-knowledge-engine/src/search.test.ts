import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createSearchTools } from "./search";
import type { KnowledgeEngineFetch } from "./shared";

type FetchStub = KnowledgeEngineFetch & {
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

const BASE_CONFIG = {
  apiKey: "svc-token",
  baseURL: "https://engine.example.com",
  tenantId: "tenant_abc",
  principalId: "principal_xyz",
};

describe("createSearchTools", () => {
  it("returns one tool with the expected definition name", () => {
    const tools = createSearchTools(BASE_CONFIG);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("search_company_knowledge");
  });

  it("throws when tenantId is missing", () => {
    expect(() => createSearchTools({ ...BASE_CONFIG, tenantId: "" })).toThrow(
      "Knowledge engine tenantId is required",
    );
  });

  it("throws when apiKey is empty", () => {
    expect(() => createSearchTools({ ...BASE_CONFIG, apiKey: "" })).toThrow(
      "Knowledge engine service token is required",
    );
  });

  it("throws when baseURL is not a valid URL", () => {
    expect(() =>
      createSearchTools({ ...BASE_CONFIG, baseURL: "not-a-url" }),
    ).toThrow("Knowledge engine baseURL must be a valid URL");
  });
});

describe("search_company_knowledge handler", () => {
  it("posts the query with tenant/principal from context, not args, and shapes the hits", async () => {
    const stubResponse = {
      hits: [
        {
          document_id: "doc_1",
          title: "Q3 renewal call",
          snippet: "...discussed the pricing tier increase...",
          score: 0.92,
        },
      ],
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createSearchTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "search_company_knowledge",
        arguments: {
          query: "pricing tier increase",
          // A malicious/confused agent supplying its own tenant_id must be
          // ignored — only the schema-declared `query`/`k` fields are read.
          tenant_id: "attacker_tenant",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content)) as {
      hits: {
        documentId: string;
        title: string;
        snippet: string;
        score: number;
      }[];
    };
    expect(parsed.hits).toEqual([
      {
        documentId: "doc_1",
        title: "Q3 renewal call",
        snippet: "...discussed the pricing tier increase...",
        score: 0.92,
      },
    ]);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://engine.example.com/api/search");
    const body = JSON.parse(String(call?.[1].body));
    expect(body).toEqual({
      query: "pricing tier increase",
      tenant_id: "tenant_abc",
      principal_id: "principal_xyz",
      k: 10,
    });
  });

  it("clamps k to the maximum", async () => {
    const fetcher = makeFetchStub({ hits: [] });
    const runner = createToolRunner(
      createSearchTools({ ...BASE_CONFIG, fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "search_company_knowledge",
        arguments: { query: "anything", k: 500 },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body.k).toBe(50);
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid token" }, 401);
    const runner = createToolRunner(
      createSearchTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "search_company_knowledge",
        arguments: { query: "anything" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Knowledge engine API error: 401");
  });

  it("surfaces a validation error when the engine response is malformed", async () => {
    const fetcher = makeFetchStub({ hits: [{ title: "missing fields" }] });
    const runner = createToolRunner(
      createSearchTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "search_company_knowledge",
        arguments: { query: "anything" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid engine response");
  });
});
