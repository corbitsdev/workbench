import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { NOTION_HUB_TOOLS, type NotionFetch, createNotionTools } from "./index";

type FetchStub = NotionFetch & {
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

describe("createNotionTools", () => {
  it("exposes the notion tools", () => {
    const tools = createNotionTools({ apiKey: "test-key" });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([
      "notion_create_page",
      "notion_get_database",
      "notion_get_page",
      "notion_get_page_content",
      "notion_query_database",
      "notion_search",
    ]);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createNotionTools({ apiKey: "" })).toThrow(
      "Notion apiKey is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createNotionTools({ apiKey: "test-key", baseUrl: "not-a-url" }),
    ).toThrow("Notion baseUrl must be a valid URL");
  });
});

describe("notion_search handler", () => {
  it("POSTs /v1/search with the Bearer and version headers and default page size", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_search", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.notion.com/v1/search");
    expect(call?.[1].method).toBe("POST");
    const headers = call?.[1].headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-key");
    expect(headers?.["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(String(call?.[1].body))).toEqual({ page_size: 25 });
  });

  it("forwards query, a page/database filter, page size and cursor", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_search",
        arguments: {
          query: "Maven",
          filterType: "database",
          pageSize: 500,
          startCursor: "cursor_1",
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      page_size: 100,
      query: "Maven",
      filter: { property: "object", value: "database" },
      start_cursor: "cursor_1",
    });
  });

  it("rejects an invalid filterType", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_search",
        arguments: { filterType: "block" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('filterType must be "page" or "database"');
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("honors a custom notionVersion", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({
        apiKey: "test-key",
        notionVersion: "2025-09-03",
        fetcher,
      }),
    );

    await runner.run(
      { id: "call_1", name: "notion_search", arguments: {} },
      new AbortController().signal,
    );

    const headers = fetcher.mock.calls[0]?.[1].headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["Notion-Version"]).toBe("2025-09-03");
  });
});

describe("notion_get_page handler", () => {
  it("GETs the encoded page path", async () => {
    const fetcher = makeFetchStub({ id: "page_1", object: "page" });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_get_page",
        arguments: { pageId: "page/1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      id: "page_1",
      object: "page",
    });
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.notion.com/v1/pages/page%2F1");
    expect(call?.[1].method).toBe("GET");
  });

  it("requires the pageId argument", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_get_page", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("pageId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("notion_get_page_content handler", () => {
  it("GETs the block children with pagination in the query string", async () => {
    const fetcher = makeFetchStub({ results: [], has_more: false });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_get_page_content",
        arguments: { blockId: "block_1", pageSize: 10, startCursor: "cur" },
      },
      new AbortController().signal,
    );

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/blocks/block_1/children");
    expect(url.searchParams.get("page_size")).toBe("10");
    expect(url.searchParams.get("start_cursor")).toBe("cur");
    expect(fetcher.mock.calls[0]?.[1].method).toBe("GET");
  });

  it("requires the blockId argument", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_get_page_content", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blockId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("notion_get_database handler", () => {
  it("GETs the encoded database path", async () => {
    const fetcher = makeFetchStub({ id: "db_1", object: "database" });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_get_database",
        arguments: { databaseId: "db/1" },
      },
      new AbortController().signal,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.notion.com/v1/databases/db%2F1",
    );
    expect(fetcher.mock.calls[0]?.[1].method).toBe("GET");
  });

  it("requires the databaseId argument", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_get_database", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("databaseId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("notion_query_database handler", () => {
  it("POSTs to the encoded query path with default page size", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_query_database",
        arguments: { databaseId: "db_1" },
      },
      new AbortController().signal,
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.notion.com/v1/databases/db_1/query");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({ page_size: 25 });
  });

  it("forwards filter, sorts and cursor into the body", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_query_database",
        arguments: {
          databaseId: "db_1",
          filter: { property: "Status", select: { equals: "Done" } },
          sorts: [{ property: "Name", direction: "ascending" }],
          startCursor: "cur",
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      page_size: 25,
      filter: { property: "Status", select: { equals: "Done" } },
      sorts: [{ property: "Name", direction: "ascending" }],
      start_cursor: "cur",
    });
  });

  it("requires the databaseId argument", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_query_database", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("databaseId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("notion_create_page handler", () => {
  it("creates a page under a parent page, building title and paragraph blocks", async () => {
    const fetcher = makeFetchStub({ id: "page_new", object: "page" });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_create_page",
        arguments: {
          parentPageId: "parent_1",
          title: "Call notes",
          text: "Discussed the pilot.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.notion.com/v1/pages");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      parent: { page_id: "parent_1" },
      properties: {
        title: { title: [{ type: "text", text: { content: "Call notes" } }] },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: "Discussed the pilot." } },
            ],
          },
        },
      ],
    });
  });

  it("creates a database row from parentDatabaseId + properties, with raw children", async () => {
    const fetcher = makeFetchStub({ id: "page_new" });
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "notion_create_page",
        arguments: {
          parentDatabaseId: "db_1",
          properties: { Name: { title: [{ text: { content: "Row" } }] } },
          children: [{ object: "block", type: "divider", divider: {} }],
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      parent: { database_id: "db_1" },
      properties: { Name: { title: [{ text: { content: "Row" } }] } },
      children: [{ object: "block", type: "divider", divider: {} }],
    });
  });

  it("requires a parent", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_create_page",
        arguments: { title: "orphan" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "parentPageId or parentDatabaseId is required",
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("rejects passing both parents", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_create_page",
        arguments: {
          parentPageId: "p1",
          parentDatabaseId: "db1",
          title: "x",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "pass only one of parentPageId or parentDatabaseId",
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("requires title or properties", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_create_page",
        arguments: { parentPageId: "p1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("title or properties is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("error handling", () => {
  it("surfaces API errors with a parsed message", async () => {
    const fetcher = makeFetchStub({ message: "Invalid token" }, 401);
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_search", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notion API error: 401 Invalid token");
  });

  it("uses the HTTP status text when the error body is empty", async () => {
    const fetcher: NotionFetch = mock(() =>
      Promise.resolve(
        new Response("", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "notion_search", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notion API error: 502 Bad Gateway");
  });

  it("surfaces a non-JSON error body verbatim", async () => {
    const fetcher: NotionFetch = mock(() =>
      Promise.resolve(
        new Response("rate limited", { status: 429, statusText: "" }),
      ),
    );
    const runner = createToolRunner(
      createNotionTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "notion_query_database",
        arguments: { databaseId: "db_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notion API error: 429 rate limited");
  });
});

describe("NOTION_HUB_TOOLS", () => {
  it("builds each tool from resolved credentials under the notion provider", () => {
    for (const [name, entry] of Object.entries(NOTION_HUB_TOOLS)) {
      expect(entry.providerName).toBe("notion");
      expect(entry.definition.name).toBe(name);
      const tools = entry.createTools({
        apiKey: "k",
        baseURL: "https://api.notion.com",
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(name);
    }
  });

  it("honors a non-empty baseURL override", async () => {
    const fetcher = makeFetchStub({ results: [] });
    const tools = NOTION_HUB_TOOLS.notion_search.createTools({
      apiKey: "k",
      baseURL: "https://notion.test",
    });
    // The hub createTools path does not accept a fetcher, so exercise the base
    // resolution via createNotionTools directly to confirm override behavior.
    const direct = createNotionTools({
      apiKey: "k",
      baseUrl: "https://notion.test",
      fetcher,
    });
    const runner = createToolRunner(direct);
    await runner.run(
      { id: "c", name: "notion_search", arguments: {} },
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://notion.test/v1/search");
    expect(tools).toHaveLength(1);
  });
});
