import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  MEMORY_ADD_TOOL,
  MEMORY_LIST_TOOL,
  MEMORY_SEARCH_TOOL,
  memoryTools,
} from "./tool";
import type { WorkflowMemoryEnv } from "./tool";

function testEnv(): WorkflowMemoryEnv {
  return {
    hubMemoryUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowMemoryEnv;
}

function callFor(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares the memory_search, memory_add, and memory_list tools", () => {
  const bundle = memoryTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    MEMORY_SEARCH_TOOL,
    MEMORY_ADD_TOOL,
    MEMORY_LIST_TOOL,
  ]);
});

test("requires the sanctioned workflow-memory env keys, not a per-user credential", () => {
  expect(memoryTools.requires).toEqual([
    "hubMemoryUrl",
    "sidecarToken",
    "address",
  ]);
});

test("no tool's input schema accepts a tenant or principal argument — attribution is never model-supplied", () => {
  const bundle = memoryTools(testEnv());
  for (const definition of bundle.definitions) {
    const properties = (
      definition as unknown as {
        inputSchema?: { properties?: Record<string, unknown> };
      }
    ).inputSchema?.properties;
    expect(properties?.["tenantId"]).toBeUndefined();
    expect(properties?.["principalId"]).toBeUndefined();
  }
});

test("memory_search returns matching items on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
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
    )) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_SEARCH_TOOL, { query: "what did we decide" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as {
      items: { documentId: string }[];
    };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.documentId).toBe("doc_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory_search rejects a missing query without calling out", async () => {
  const bundle = memoryTools(testEnv());
  const result = await bundle.run(
    callFor(MEMORY_SEARCH_TOOL, {}),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/requires a query/);
});

test("memory_add returns the created ids on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: { documentId: "doc_1", versionId: "ver_1" } }),
      { status: 201 },
    )) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_ADD_TOOL, { title: "Note", text: "hello" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toEqual({
      documentId: "doc_1",
      versionId: "ver_1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory_add rejects missing title or text without calling out", async () => {
  const bundle = memoryTools(testEnv());
  const missingTitle = await bundle.run(
    callFor(MEMORY_ADD_TOOL, { text: "hello" }),
    new AbortController().signal,
  );
  expect(missingTitle.isError).toBe(true);
  expect(missingTitle.content).toMatch(/requires a title/);

  const missingText = await bundle.run(
    callFor(MEMORY_ADD_TOOL, { title: "Note" }),
    new AbortController().signal,
  );
  expect(missingText.isError).toBe(true);
  expect(missingText.content).toMatch(/requires text/);
});

test("memory_list returns recent entries on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { at: "2026-08-13T00:00:00.000Z", title: "Note", source: "local" },
        ],
      }),
    )) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_LIST_TOOL),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as {
      entries: { at: string; title: string; source: string }[];
    };
    expect(parsed.entries).toEqual([
      { at: "2026-08-13T00:00:00.000Z", title: "Note", source: "local" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory_search degrades calmly when the memory plane isn't mounted, without isError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unavailable",
          message: "Memory plane is not configured on this hub",
        },
      }),
      { status: 503 },
    )) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_SEARCH_TOOL, { query: "q" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/isn't set up on this server yet/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory_add degrades calmly when the memory plane isn't mounted, without isError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unavailable",
          message: "Memory plane is not configured on this hub",
        },
      }),
      { status: 503 },
    )) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_ADD_TOOL, { title: "Note", text: "hello" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/isn't set up on this server yet/);
    expect(result.content).toMatch(/not saved/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an honest error result on an unreachable hub, never fabricating a memory result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
  try {
    const bundle = memoryTools(testEnv());
    const result = await bundle.run(
      callFor(MEMORY_SEARCH_TOOL, { query: "q" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown tool name returns an honest error, never a silent no-op", async () => {
  const bundle = memoryTools(testEnv());
  const result = await bundle.run(
    callFor("memory_delete_everything"),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
