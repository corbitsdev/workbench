import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("../config", () => ({
  loadConfig: () => ({
    pricing: {
      apiUrl: "https://models.dev/api.json",
      logosBaseUrl: "https://models.dev/logos",
      ttlMs: 1000,
      fetchTimeoutMs: 1000,
    },
  }),
}));

const { getPriceCatalog, resetPriceCatalogCache } = await import(
  "@workbench/pricing"
);

const { getProviderLogo, resetProviderLogoCache, prewarmPriceCatalog } =
  await import("./pricing");

afterEach(() => {
  resetProviderLogoCache();
  resetPriceCatalogCache();
});

function svgResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

const PRICING_PAYLOAD = {
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("prewarmPriceCatalog", () => {
  it("warms the shared cache so a later request serves without refetching", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(PRICING_PAYLOAD);
    }) as unknown as typeof fetch;
    try {
      await prewarmPriceCatalog();
      expect(calls).toBe(1);

      // A subsequent request hits the warm cache — no second models.dev fetch.
      const catalog = await getPriceCatalog({
        url: "https://models.dev/api.json",
        ttlMs: 1000,
        timeoutMs: 1000,
      });
      expect(catalog.models["claude-opus-4-5"]?.input).toBe(5);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not throw when models.dev is unavailable, so boot is never blocked", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("models.dev down");
    }) as unknown as typeof fetch;
    try {
      await expect(prewarmPriceCatalog()).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("getProviderLogo", () => {
  it("returns svg markup and caches it within the TTL", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return svgResponse("<svg>anthropic</svg>");
    }) as unknown as typeof fetch;

    const first = await getProviderLogo("anthropic", {
      fetchImpl,
      now: () => 0,
    });
    const second = await getProviderLogo("anthropic", {
      fetchImpl,
      now: () => 500,
    });
    expect(first).toContain("<svg");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("returns null for a 404", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const logo = await getProviderLogo("missing", { fetchImpl, now: () => 0 });
    expect(logo).toBeNull();
  });

  it("returns null when the body is not SVG", async () => {
    const fetchImpl = (async () =>
      svgResponse("<html>not a logo</html>")) as unknown as typeof fetch;
    const logo = await getProviderLogo("bogus", { fetchImpl, now: () => 0 });
    expect(logo).toBeNull();
  });

  it("negatively caches a miss instead of re-hitting upstream every mount", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    await getProviderLogo("missing", { fetchImpl, now: () => 0 });
    // Second mount shortly after: served from the negative cache, no refetch.
    await getProviderLogo("missing", { fetchImpl, now: () => 1000 });
    expect(calls).toBe(1);

    // Past the negative-cache window (5 min): retried in case a logo appeared.
    const later = await getProviderLogo("missing", {
      fetchImpl,
      now: () => 6 * 60_000,
    });
    expect(later).toBeNull();
    expect(calls).toBe(2);
  });
});
