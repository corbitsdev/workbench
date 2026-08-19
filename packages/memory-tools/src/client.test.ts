import { expect, test } from "bun:test";

import { addMemory, listMemory, searchMemory } from "./client";

const CONFIG = {
  hubMemoryUrl: "https://hub.example.com",
  sidecarToken: "sc-token",
  runAddress: "run_1@workflow",
};

test("searchMemory posts to the memory search endpoint and returns items", async () => {
  const captured: { url: string; init: RequestInit | undefined } = {
    url: "",
    init: undefined,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(
      JSON.stringify({
        items: [
          {
            documentId: "doc_1",
            title: "Decision",
            snippet: "We decided...",
            score: 0.9,
            kind: "decision",
          },
        ],
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
    "https://hub.example.com/api/tenants/workflow-run/memory/search",
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
    new Response(JSON.stringify({}), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    searchMemory({ ...CONFIG, fetchImpl }, { query: "q" }),
  ).rejects.toThrow(/did not match the expected shape/);
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
      JSON.stringify({ documentId: "doc_1", versionId: "ver_1" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await addMemory(
    { ...CONFIG, fetchImpl },
    { title: "Note", text: "hello", kind: "fact" },
  );

  expect(result).toEqual({ documentId: "doc_1", versionId: "ver_1" });
  expect(captured.url).toBe(
    "https://hub.example.com/api/tenants/workflow-run/memory/add",
  );
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

test("listMemory GETs the list endpoint with the limit query param", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(
      JSON.stringify({
        events: [
          {
            at: "2026-08-13T00:00:00.000Z",
            title: "Note",
            source: "local",
            tenantId: "tnt_1",
            principalId: "prn_1",
          },
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
    "https://hub.example.com/api/tenants/workflow-run/memory/list?limit=5",
  );
});

test("listMemory omits the query param when no limit is given", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await listMemory({ ...CONFIG, fetchImpl });

  expect(captured.url).toBe(
    "https://hub.example.com/api/tenants/workflow-run/memory/list",
  );
});

test("listMemory throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(listMemory({ ...CONFIG, fetchImpl })).rejects.toThrow(/401/);
});
