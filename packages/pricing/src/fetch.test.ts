import { afterEach, describe, expect, test } from "bun:test";
import {
  PriceCatalogFetchError,
  getPriceCatalog,
  resetPriceCatalogCache,
} from "./fetch";

const PAYLOAD = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        cost: { input: 5, output: 25 },
      },
    },
  },
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => resetPriceCatalogCache());

describe("getPriceCatalog", () => {
  test("fetches, parses, and builds a catalog", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return okResponse(PAYLOAD);
    }) as unknown as typeof fetch;

    const catalog = await getPriceCatalog({
      url: "https://models.dev/api.json",
      ttlMs: 1000,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 0,
    });
    expect(catalog.models["claude-opus-4-5"]?.input).toBe(5);
    expect(calls).toBe(1);
  });

  test("serves from cache within the TTL and refetches after it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return okResponse(PAYLOAD);
    }) as unknown as typeof fetch;
    const url = "https://models.dev/api.json";

    await getPriceCatalog({
      url,
      ttlMs: 1000,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 0,
    });
    await getPriceCatalog({
      url,
      ttlMs: 1000,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 500,
    });
    expect(calls).toBe(1);

    await getPriceCatalog({
      url,
      ttlMs: 1000,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 2000,
    });
    expect(calls).toBe(2);
  });

  test("throws on a non-ok response with no cached fallback", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      getPriceCatalog({
        url: "https://models.dev/api.json",
        ttlMs: 1000,
        timeoutMs: 1000,
        fetchImpl,
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(PriceCatalogFetchError);
  });

  test("serves a stale catalog when a refresh fails", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return okResponse(PAYLOAD);
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const url = "https://models.dev/api.json";

    const first = await getPriceCatalog({
      url,
      ttlMs: 100,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 0,
    });
    const second = await getPriceCatalog({
      url,
      ttlMs: 100,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 1000,
    });
    expect(second.models).toEqual(first.models);
    expect(calls).toBe(2);
  });

  test("dedupes two overlapping misses onto a single fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await Promise.resolve();
      return okResponse(PAYLOAD);
    }) as unknown as typeof fetch;
    const opts = {
      url: "https://models.dev/api.json",
      ttlMs: 1000,
      timeoutMs: 1000,
      fetchImpl,
      now: () => 0,
    };

    const [a, b] = await Promise.all([
      getPriceCatalog(opts),
      getPriceCatalog(opts),
    ]);
    expect(calls).toBe(1);
    expect(a.models).toEqual(b.models);
  });

  test("aborts and fails a hung fetch after the timeout", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    await expect(
      getPriceCatalog({
        url: "https://models.dev/api.json",
        ttlMs: 1000,
        timeoutMs: 5,
        fetchImpl,
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(PriceCatalogFetchError);
  });

  test("stops refetching for a backoff window after a failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return okResponse(PAYLOAD);
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const url = "https://models.dev/api.json";
    const base = { url, ttlMs: 100, timeoutMs: 1000, fetchImpl };

    await getPriceCatalog({ ...base, now: () => 0 });
    await getPriceCatalog({ ...base, now: () => 1000 });
    expect(calls).toBe(2);
    await getPriceCatalog({ ...base, now: () => 1500 });
    expect(calls).toBe(2);
  });

  test("throws PriceCatalogFetchError on a malformed payload", async () => {
    const fetchImpl = (async () =>
      okResponse({
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          models: { x: { id: "x", cost: { input: "free" } } },
        },
      })) as unknown as typeof fetch;
    await expect(
      getPriceCatalog({
        url: "https://models.dev/api.json",
        ttlMs: 1000,
        timeoutMs: 1000,
        fetchImpl,
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(PriceCatalogFetchError);
  });
});
