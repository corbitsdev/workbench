import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { WEB_SEARCH_TOOL, webSearchTools } from "./tool";
import type { WebSearchEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: WEB_SEARCH_TOOL,
  arguments: { query: "agent workflows" },
};

function fakeEnv(webSearchApiKey: string | undefined): WebSearchEnv {
  return { webSearchApiKey } as unknown as WebSearchEnv;
}

test("declares the web_search tool", () => {
  const bundle = webSearchTools(fakeEnv("key"));
  expect(bundle.definitions.map((d) => d.name)).toEqual([WEB_SEARCH_TOOL]);
});

test("degrades to a non-throwing 'not connected' error when no credential is set", async () => {
  const bundle = webSearchTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way for an empty-string credential", async () => {
  const bundle = webSearchTools(fakeEnv(""));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
});

test("rejects a missing query without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv("key"));
    const result = await bundle.run(
      { id: "call_2", name: WEB_SEARCH_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns results as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "Agent workflows explained",
            url: "https://example.test/a",
            publishedDate: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      results: unknown[];
    };
    expect(parsed.results).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
