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

const { getProviderLogo, resetProviderLogoCache } = await import("./pricing");

afterEach(() => resetProviderLogoCache());

function svgResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

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
