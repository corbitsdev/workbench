import { expect, test } from "bun:test";

import { searchWeb } from "./client";

test("returns normalized results on a successful call", async () => {
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string> | undefined)?.["x-api-key"],
    ).toBe("test-key");
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toEqual({ query: "agent workflows", numResults: 5 });
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Agent workflows explained",
            url: "https://example.test/a",
            publishedDate: "2026-08-01T00:00:00.000Z",
            author: "Jane Doe",
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const results = await searchWeb(
    { apiKey: "test-key", fetchImpl },
    { query: "agent workflows" },
  );
  expect(results).toEqual([
    {
      url: "https://example.test/a",
      title: "Agent workflows explained",
      publishedAt: "2026-08-01T00:00:00.000Z",
      source: "web",
      author: "Jane Doe",
    },
  ]);
});

test("falls back to fetch time and marks provenance degraded when a result has no publish date", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        results: [{ title: "Undated page", url: "https://example.test/b" }],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const results = await searchWeb(
    { apiKey: "test-key", fetchImpl },
    { query: "topic" },
  );
  expect(results).toHaveLength(1);
  expect(results[0]?.provenance).toBe("degraded");
  expect(typeof results[0]?.publishedAt).toBe("string");
});

test("drops results with no url", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ results: [{ title: "No url" }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const results = await searchWeb(
    { apiKey: "test-key", fetchImpl },
    { query: "topic" },
  );
  expect(results).toEqual([]);
});

test("clamps numResults to the 1-25 range, defaulting to 5", async () => {
  const captured: unknown[] = [];
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await searchWeb(
    { apiKey: "test-key", fetchImpl },
    { query: "topic", numResults: 999 },
  );
  await searchWeb(
    { apiKey: "test-key", fetchImpl },
    { query: "topic", numResults: -1 },
  );
  expect(captured).toEqual([
    { query: "topic", numResults: 25 },
    { query: "topic", numResults: 5 },
  ]);
});

test("throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    searchWeb({ apiKey: "bad", fetchImpl }, { query: "topic" }),
  ).rejects.toThrow(/401/);
});

test("throws when the response body does not match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ results: "not-an-array" }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    searchWeb({ apiKey: "test-key", fetchImpl }, { query: "topic" }),
  ).rejects.toThrow(/did not match the expected shape/);
});
