import { expect, test } from "bun:test";

import {
  addMemory,
  listMemory,
  MemoryUnavailableError,
  searchMemory,
} from "./client";

const CONFIG = {
  hubMemoryUrl: "https://hub.example.com",
  sidecarToken: "sc-token",
  runAddress: "run_1@workflow",
};

test("searchMemory posts to the workflow-memory search endpoint and returns items", async () => {
  const captured: { url: string; init: RequestInit | undefined } = {
    url: "",
    init: undefined,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(
      JSON.stringify({
        data: {
          items: [
            {
              documentId: "doc_1",
              title: "Decision",
              snippet: "We decided...",
              score: 0.9,
              kind: "decision",
            },
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await searchMemory(
    { ...CONFIG, fetchImpl },
    { query: "what did we decide" },
  );

  expect(result).toEqual([
    {
      documentId: "doc_1",
      title: "Decision",
      snippet: "We decided...",
      score: 0.9,
      kind: "decision",
    },
  ]);
  expect(captured.url).toBe(
    "https://hub.example.com/api/workflow-memory/search",
  );
  const headers = captured.init?.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sc-token");
  expect(headers["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(JSON.parse(String(captured.init?.body))).toEqual({
    query: "what did we decide",
  });
});

test("searchMemory throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    searchMemory({ ...CONFIG, fetchImpl }, { query: "q" }),
  ).rejects.toThrow(/401/);
});

test("searchMemory throws when the response doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: {} }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    searchMemory({ ...CONFIG, fetchImpl }, { query: "q" }),
  ).rejects.toThrow(/did not match the expected shape/);
});

test("searchMemory throws MemoryUnavailableError when the hub reports the memory plane isn't mounted", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unavailable",
          message: "Memory plane is not configured on this hub",
        },
      }),
      { status: 503 },
    )) as unknown as typeof fetch;

  await expect(
    searchMemory({ ...CONFIG, fetchImpl }, { query: "q" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
});

test("addMemory posts title/text/kind and returns the created ids", async () => {
  const captured: { url: string; init: RequestInit | undefined } = {
    url: "",
    init: undefined,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(
      JSON.stringify({ data: { documentId: "doc_1", versionId: "ver_1" } }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await addMemory(
    { ...CONFIG, fetchImpl },
    { title: "Note", text: "hello", kind: "fact" },
  );

  expect(result).toEqual({ documentId: "doc_1", versionId: "ver_1" });
  expect(captured.url).toBe("https://hub.example.com/api/workflow-memory/add");
  expect(JSON.parse(String(captured.init?.body))).toEqual({
    title: "Note",
    text: "hello",
    kind: "fact",
  });
});

test("addMemory throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  await expect(
    addMemory({ ...CONFIG, fetchImpl }, { title: "Note", text: "hello" }),
  ).rejects.toThrow(/500/);
});

test("addMemory throws MemoryUnavailableError when the hub reports the memory plane isn't mounted", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unavailable",
          message: "Memory plane is not configured on this hub",
        },
      }),
      { status: 503 },
    )) as unknown as typeof fetch;

  await expect(
    addMemory({ ...CONFIG, fetchImpl }, { title: "Note", text: "hello" }),
  ).rejects.toBeInstanceOf(MemoryUnavailableError);
});

test("listMemory GETs the list endpoint with the limit query param", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(
      JSON.stringify({
        data: [
          { at: "2026-08-13T00:00:00.000Z", title: "Note", source: "local" },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await listMemory({ ...CONFIG, fetchImpl }, { limit: 5 });

  expect(result).toEqual([
    { at: "2026-08-13T00:00:00.000Z", title: "Note", source: "local" },
  ]);
  expect(captured.url).toBe(
    "https://hub.example.com/api/workflow-memory/list?limit=5",
  );
});

test("listMemory omits the query param when no limit is given", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await listMemory({ ...CONFIG, fetchImpl });

  expect(captured.url).toBe("https://hub.example.com/api/workflow-memory/list");
});

test("listMemory throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(listMemory({ ...CONFIG, fetchImpl })).rejects.toThrow(/401/);
});
