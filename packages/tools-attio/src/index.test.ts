import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { ATTIO_HUB_TOOLS, type AttioFetch, createAttioTools } from "./index";

type FetchStub = AttioFetch & {
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

describe("createAttioTools", () => {
  it("exposes the read-only tools", () => {
    const tools = createAttioTools({ apiKey: "test-key" });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([
      "attio_create_note",
      "attio_create_record",
      "attio_get_record",
      "attio_get_task",
      "attio_list_objects",
      "attio_list_tasks",
      "attio_list_workspace_members",
      "attio_query_records",
      "attio_recent_activity",
      "attio_search_records",
      "attio_update_task",
    ]);
  });

  it("throws when apiKey is empty", () => {
    expect(() => createAttioTools({ apiKey: "" })).toThrow(
      "Attio apiKey is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createAttioTools({ apiKey: "test-key", baseUrl: "not-a-url" }),
    ).toThrow("Attio baseUrl must be a valid URL");
  });
});

describe("attio_list_objects handler", () => {
  it("GETs /v2/objects with a Bearer header and returns the data field", async () => {
    const fetcher = makeFetchStub({ data: [{ api_slug: "companies" }] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_objects", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([
      { api_slug: "companies" },
    ]);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/objects");
    expect(call?.[1].method).toBe("GET");
    const headers = call?.[1].headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-key");
  });
});

describe("attio_query_records handler", () => {
  it("POSTs to the encoded object query path with default pagination body", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "companies" },
      },
      new AbortController().signal,
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.attio.com/v2/objects/companies/records/query",
    );
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
    });
  });

  it("caps limit at 100 and forwards offset", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "people", limit: 500, offset: 40 },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body).toEqual({ limit: 100, offset: 40 });
  });

  it("url-encodes the object slug", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "my objects" },
      },
      new AbortController().signal,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.attio.com/v2/objects/my%20objects/records/query",
    );
  });

  it("requires the object argument", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_query_records", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("object is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("forwards a filter object into the request body", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: {
          object: "companies",
          filter: { name: { $contains: "Acme Inc" } },
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: { name: { $contains: "Acme Inc" } },
    });
  });

  it("forwards a sorts array into the request body", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: {
          object: "companies",
          sorts: [{ attribute: "name", direction: "asc" }],
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      sorts: [{ attribute: "name", direction: "asc" }],
    });
  });

  it("builds a name filter from the nameContains convenience param", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "companies", nameContains: "Tribe Capital" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: { name: { $contains: "Tribe Capital" } },
    });
  });

  it("builds a domains filter from the domainContains convenience param", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "companies", domainContains: "tribecap.com" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: { domains: { domain: { $contains: "tribecap.com" } } },
    });
  });

  it("combines nameContains and domainContains into one implicit-AND filter", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: {
          object: "companies",
          nameContains: "Tribe",
          domainContains: "tribecap.com",
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: {
        name: { $contains: "Tribe" },
        domains: { domain: { $contains: "tribecap.com" } },
      },
    });
  });

  it("prefers an explicit filter over the convenience params", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: {
          object: "companies",
          nameContains: "ignored",
          filter: { name: { $eq: "Tribe Capital" } },
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: { name: { $eq: "Tribe Capital" } },
    });
  });

  it("omits filter and sorts from the body when not provided", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "companies" },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect("filter" in body).toBe(false);
    expect("sorts" in body).toBe(false);
  });
});

describe("attio_search_records handler", () => {
  it("POSTs the query to /v2/records/search and returns the data field", async () => {
    const fetcher = makeFetchStub({ data: [{ id: { record_id: "rec_1" } }] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_search_records",
        arguments: { query: "Acme Inc" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([
      { id: { record_id: "rec_1" } },
    ]);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/records/search");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      query: "Acme Inc",
    });
  });

  it("requires the query argument", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_search_records", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("attio_get_record handler", () => {
  it("GETs the encoded record path and returns the data field", async () => {
    const fetcher = makeFetchStub({ data: { id: { record_id: "rec_1" } } });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_get_record",
        arguments: { object: "companies", recordId: "rec/1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      id: { record_id: "rec_1" },
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.attio.com/v2/objects/companies/records/rec%2F1",
    );
    expect(call?.[1].method).toBe("GET");
  });

  it("requires the recordId argument", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_get_record",
        arguments: { object: "companies" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("recordId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("attio_list_workspace_members handler", () => {
  it("GETs /v2/workspace_members", async () => {
    const fetcher = makeFetchStub({
      data: [{ id: { workspace_member_id: "wm_1" } }],
    });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_workspace_members", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.attio.com/v2/workspace_members",
    );
    expect(JSON.parse(String(result.content))).toEqual([
      { id: { workspace_member_id: "wm_1" } },
    ]);
  });
});

describe("attio_list_tasks handler", () => {
  it("GETs /v2/tasks with default pagination in the query string", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      { id: "call_1", name: "attio_list_tasks", arguments: {} },
      new AbortController().signal,
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/tasks?limit=25&offset=0");
    expect(call?.[1].method).toBe("GET");
    const headers = call?.[1].headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-key");
  });

  it("caps limit at 100", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      { id: "call_1", name: "attio_list_tasks", arguments: { limit: 999 } },
      new AbortController().signal,
    );

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("forwards assignee, is_completed and linked-record filters as snake_case query params", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_list_tasks",
        arguments: {
          assignee: "sawyer@abklabs.com",
          isCompleted: false,
          linkedObject: "companies",
          linkedRecordId: "rec_1",
          sort: "created_at:desc",
        },
      },
      new AbortController().signal,
    );

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get("assignee")).toBe("sawyer@abklabs.com");
    expect(url.searchParams.get("is_completed")).toBe("false");
    expect(url.searchParams.get("linked_object")).toBe("companies");
    expect(url.searchParams.get("linked_record_id")).toBe("rec_1");
    expect(url.searchParams.get("sort")).toBe("created_at:desc");
  });

  it("returns the data field", async () => {
    const fetcher = makeFetchStub({
      data: [{ id: { task_id: "task_1" }, content_plaintext: "Follow up" }],
    });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_tasks", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([
      { id: { task_id: "task_1" }, content_plaintext: "Follow up" },
    ]);
  });
});

type RouteStub = AttioFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeRouterStub(
  routes: {
    match: (url: string) => boolean;
    body: unknown;
    status?: number;
  }[],
): RouteStub {
  return mock((input: string, _init: RequestInit) => {
    const route = routes.find((r) => r.match(input));
    if (route === undefined) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

describe("attio_get_task handler", () => {
  it("GETs the encoded task and hydrates each linked record", async () => {
    const fetcher = makeRouterStub([
      {
        match: (u) => u.endsWith("/v2/tasks/task%2F1"),
        body: {
          data: {
            id: { task_id: "task/1" },
            content_plaintext: "Reach out",
            linked_records: [
              { target_object: "companies", target_record_id: "rec_1" },
            ],
          },
        },
      },
      {
        match: (u) => u.includes("/v2/objects/companies/records/rec_1"),
        body: {
          data: { id: { record_id: "rec_1" }, values: { name: "Acme" } },
        },
      },
    ]);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_get_task", arguments: { taskId: "task/1" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.task.content_plaintext).toBe("Reach out");
    expect(parsed.linkedRecords).toEqual([
      {
        object: "companies",
        recordId: "rec_1",
        record: { id: { record_id: "rec_1" }, values: { name: "Acme" } },
      },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.attio.com/v2/tasks/task%2F1",
    );
  });

  it("requires the taskId argument", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_get_task", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("taskId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("skips hydration when hydrateLinkedRecords is false", async () => {
    const fetcher = makeRouterStub([
      {
        match: (u) => u.endsWith("/v2/tasks/task_1"),
        body: {
          data: {
            id: { task_id: "task_1" },
            linked_records: [
              { target_object: "companies", target_record_id: "rec_1" },
            ],
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_get_task",
        arguments: { taskId: "task_1", hydrateLinkedRecords: false },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.linkedRecords).toEqual([
      { object: "companies", recordId: "rec_1" },
    ]);
    // Only the task GET happened — no record hydration.
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("captures a hydration error per record without failing the whole call", async () => {
    const fetcher = makeRouterStub([
      {
        match: (u) => u.endsWith("/v2/tasks/task_1"),
        body: {
          data: {
            id: { task_id: "task_1" },
            linked_records: [
              { target_object: "companies", target_record_id: "rec_1" },
            ],
          },
        },
      },
      {
        match: (u) => u.includes("/v2/objects/companies/records/rec_1"),
        body: { message: "Not found" },
        status: 404,
      },
    ]);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_get_task", arguments: { taskId: "task_1" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.linkedRecords[0].recordId).toBe("rec_1");
    expect(parsed.linkedRecords[0].record).toBeUndefined();
    expect(String(parsed.linkedRecords[0].error)).toContain("404");
  });
});

describe("attio_update_task handler", () => {
  it("PATCHes the encoded task with only the provided fields wrapped in data", async () => {
    const fetcher = makeFetchStub({
      data: { id: { task_id: "task_1" }, is_completed: true },
    });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_update_task",
        arguments: { taskId: "task/1", isCompleted: true },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/tasks/task%2F1");
    expect(call?.[1].method).toBe("PATCH");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      data: { is_completed: true },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      id: { task_id: "task_1" },
      is_completed: true,
    });
  });

  it("forwards a deadline update", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_update_task",
        arguments: { taskId: "task_1", deadlineAt: "2026-08-01T00:00:00Z" },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      data: { deadline_at: "2026-08-01T00:00:00Z" },
    });
  });

  it("requires the taskId argument", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_update_task",
        arguments: { isCompleted: true },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("taskId is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("errors when no updatable field is provided", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_update_task",
        arguments: { taskId: "task_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no task fields to update");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("attio_create_note handler", () => {
  it("POSTs /v2/notes with the parent, content and defaults", async () => {
    const fetcher = makeFetchStub({ data: { id: { note_id: "note_1" } } });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "Approved outreach draft",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/notes");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      data: {
        parent_object: "companies",
        parent_record_id: "rec_1",
        title: "",
        format: "markdown",
        content: "Approved outreach draft",
      },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      id: { note_id: "note_1" },
    });
  });

  it("forwards an explicit title and plaintext format", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "note",
          title: "BD follow-up",
          format: "plaintext",
        },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body.data.title).toBe("BD follow-up");
    expect(body.data.format).toBe("plaintext");
  });

  it("requires parentObject, parentRecordId and content", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: { parentObject: "companies", parentRecordId: "rec_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("content is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("skips the POST and returns the existing note when idempotencyKey already marks a note", async () => {
    const fetcher = makeRouterStub([
      {
        match: (u) => u.includes("/v2/notes?"),
        body: {
          data: [
            {
              id: { note_id: "note_existing" },
              content_markdown:
                "Approved outreach draft\n\n<!-- idem:run_42 -->",
            },
          ],
        },
      },
    ]);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "Approved outreach draft",
          idempotencyKey: "run_42",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.deduped).toBe(true);
    expect(parsed.note.id.note_id).toBe("note_existing");
    // Only the list-notes GET happened — no create POST.
    expect(fetcher.mock.calls).toHaveLength(1);
    const listCall = fetcher.mock.calls[0];
    const listUrl = new URL(String(listCall?.[0]));
    expect(listUrl.pathname).toBe("/v2/notes");
    expect(listUrl.searchParams.get("parent_object")).toBe("companies");
    expect(listUrl.searchParams.get("parent_record_id")).toBe("rec_1");
    expect(listCall?.[1].method).toBe("GET");
  });

  it("POSTs with the marker appended when idempotencyKey has no matching note", async () => {
    const fetcher = makeRouterStub([
      {
        match: (u) => u.includes("/v2/notes?"),
        body: { data: [] },
      },
      {
        match: (u) => u.endsWith("/v2/notes"),
        body: { data: { id: { note_id: "note_new" } } },
      },
    ]);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "Approved outreach draft",
          idempotencyKey: "run_42",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      id: { note_id: "note_new" },
    });

    const postCall = fetcher.mock.calls.find(
      (c) => c[1].method === "POST" && String(c[0]).endsWith("/v2/notes"),
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall?.[1].body));
    expect(body.data.content).toBe(
      "Approved outreach draft\n\n<!-- idem:run_42 -->",
    );
  });

  it("does not list or append a marker when idempotencyKey is absent", async () => {
    const fetcher = makeFetchStub({ data: { id: { note_id: "note_1" } } });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "Approved outreach draft",
        },
      },
      new AbortController().signal,
    );

    // Single POST, no preflight list-notes GET.
    expect(fetcher.mock.calls).toHaveLength(1);
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.attio.com/v2/notes");
    expect(call?.[1].method).toBe("POST");
    const body = JSON.parse(String(call?.[1].body));
    expect(body.data.content).toBe("Approved outreach draft");
  });

  it("rejects an invalid format", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_note",
        arguments: {
          parentObject: "companies",
          parentRecordId: "rec_1",
          content: "x",
          format: "html",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'format must be "plaintext" or "markdown"',
    );
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("attio_create_record handler", () => {
  it("POSTs /v2/objects/{object}/records with the values wrapped in data", async () => {
    const fetcher = makeFetchStub({
      data: { id: { record_id: "rec_new" } },
    });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: {
          object: "companies",
          values: { name: "Tribe Capital", domains: ["tribecap.com"] },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://api.attio.com/v2/objects/companies/records",
    );
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      data: { values: { name: "Tribe Capital", domains: ["tribecap.com"] } },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      id: { record_id: "rec_new" },
    });
  });

  it("url-encodes the object slug", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: { object: "deal flow", values: { name: "X" } },
      },
      new AbortController().signal,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.attio.com/v2/objects/deal%20flow/records",
    );
  });

  it("PUTs the assert endpoint with matching_attribute for an idempotent upsert", async () => {
    const fetcher = makeFetchStub({ data: { id: { record_id: "rec_up" } } });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: {
          object: "companies",
          values: { domains: ["tribecap.com"], name: "Tribe" },
          matchingAttribute: "domains",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    const url = new URL(String(call?.[0]));
    expect(url.pathname).toBe("/v2/objects/companies/records");
    expect(url.searchParams.get("matching_attribute")).toBe("domains");
    expect(call?.[1].method).toBe("PUT");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      data: { values: { domains: ["tribecap.com"], name: "Tribe" } },
    });
  });

  it("requires object", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: { values: { name: "X" } },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("object is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("rejects an array passed as values before hitting the API", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: { object: "companies", values: ["Tribe Capital"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("values is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("requires a non-empty values object", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_create_record",
        arguments: { object: "companies", values: {} },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("values is required");
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe("error handling", () => {
  it("surfaces API errors with a parsed message", async () => {
    const fetcher = makeFetchStub({ message: "Invalid token" }, 401);
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_objects", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Attio API error: 401 Invalid token");
  });

  it("uses the HTTP status text when the error body is empty", async () => {
    const fetcher: AttioFetch = mock(() =>
      Promise.resolve(
        new Response("", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_objects", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Attio API error: 502 Bad Gateway");
  });

  it("surfaces a non-JSON error body verbatim", async () => {
    const fetcher: AttioFetch = mock(() =>
      Promise.resolve(
        new Response("rate limited", { status: 429, statusText: "" }),
      ),
    );
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "attio_query_records",
        arguments: { object: "companies" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Attio API error: 429 rate limited");
  });

  it("errors when the response is missing the data field", async () => {
    const fetcher = makeFetchStub({ notData: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "attio_list_objects", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Attio response is missing the data field",
    );
  });
});

describe("ATTIO_HUB_TOOLS", () => {
  it("builds each tool from resolved credentials under the attio provider", () => {
    for (const [name, entry] of Object.entries(ATTIO_HUB_TOOLS)) {
      expect(entry.providerName).toBe("attio");
      expect(entry.definition.name).toBe(name);
      const tools = entry.createTools({
        apiKey: "k",
        baseURL: "https://api.attio.com",
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(name);
    }
  });

  it("honors a non-empty baseURL override", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const tools = ATTIO_HUB_TOOLS.attio_list_objects.createTools({
      apiKey: "k",
      baseURL: "https://eu.attio.test",
    });
    // The hub createTools path does not accept a fetcher, so exercise the default
    // base resolution via createAttioTools directly to confirm override behavior.
    const direct = createAttioTools({
      apiKey: "k",
      baseUrl: "https://eu.attio.test",
      fetcher,
    });
    const runner = createToolRunner(direct);
    await runner.run(
      { id: "c", name: "attio_list_objects", arguments: {} },
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://eu.attio.test/v2/objects");
    expect(tools).toHaveLength(1);
  });
});

describe("attio_recent_activity handler", () => {
  it("accepts a hub-enriched heartbeat trigger payload (extra mail fields)", async () => {
    const fetcher: AttioFetch = mock(async (url: string) => {
      if (url.includes("/records/query")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: { record_id: "rec_1" },
                created_at: "2026-07-05T00:00:00Z",
                web_url: "https://app.attio.com/textql/company/rec_1",
                values: { name: [{ value: "Acme Corp" }] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "attio_recent_activity",
        arguments: {
          reason: "manual-brief",
          userAddress: "usr_abc@workbench.local",
          userRefId: "usr_abc",
          enabledSources: ["attio"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(
      JSON.parse(String(result.content)).attioActivity.newCompanies,
    ).toHaveLength(1);
  });

  it("skips the network call and reports skipped when attio is not in enabledSources", async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "attio_recent_activity",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.content))).toEqual({ skipped: true });
  });

  it("forwards createdAfter as a companies filter and returns a uniquely-keyed compact snapshot", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher: AttioFetch = mock(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/records/query")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: { record_id: "rec_1" },
                created_at: "2026-07-05T00:00:00Z",
                web_url: "https://app.attio.com/textql/company/rec_1",
                values: { name: [{ value: "Acme Corp" }] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: { task_id: "task_1" },
              content_plaintext: "Follow up with Acme",
              deadline_at: "2026-07-10T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "attio_recent_activity",
        arguments: {
          createdAfter: "2026-07-04T00:00:00Z",
          enabledSources: ["attio"],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      attioActivity: {
        newCompanies: [
          {
            id: "rec_1",
            name: "Acme Corp",
            createdAt: "2026-07-05T00:00:00Z",
            url: "https://app.attio.com/textql/company/rec_1",
          },
        ],
        openTasks: [
          {
            id: "task_1",
            content: "Follow up with Acme",
            deadlineAt: "2026-07-10T00:00:00Z",
          },
        ],
      },
    });

    const companiesCall = calls.find((c) => c.url.includes("/records/query"));
    expect(companiesCall?.body).toMatchObject({
      filter: { created_at: { $gte: "2026-07-04T00:00:00Z" } },
    });
    const tasksCall = calls.find((c) => c.url.includes("/v2/tasks"));
    expect(tasksCall?.url).toContain("is_completed=false");
  });

  it("omits url rather than fabricating one when a company record has no web_url", async () => {
    const fetcher: AttioFetch = mock(async (url: string) => {
      if (url.includes("/records/query")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: { record_id: "rec_2" },
                created_at: "2026-07-05T00:00:00Z",
                values: { name: [{ value: "No Link Inc" }] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const runner = createToolRunner(
      createAttioTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "attio_recent_activity",
        arguments: { enabledSources: ["attio"] },
      },
      new AbortController().signal,
    );

    const newCompanies = JSON.parse(String(result.content)).attioActivity
      .newCompanies;
    expect(newCompanies).toEqual([
      {
        id: "rec_2",
        name: "No Link Inc",
        createdAt: "2026-07-05T00:00:00Z",
        url: null,
      },
    ]);
  });
});
