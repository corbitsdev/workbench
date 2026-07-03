/// <reference types="bun" />
// Contract tests for the Insights actor-search and per-principal activity
// client functions: URL construction under the tenant-scoped `/api` prefix,
// boundary parsing through the exported arktype schemas, and error paths.
import { describe, expect, it, mock } from "bun:test";
import "./test-setup";
import { getPrincipalActivity, searchActors } from "./index";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = mock(impl);
  const fetcher = Object.assign(
    (input: FetchArgs[0], init?: FetchArgs[1]) => spy(input, init),
    { preconnect: mock(() => {}) },
  ) as unknown as typeof fetch;
  return { spy, fetcher };
}

const BASE = "http://localhost:4000";

describe("searchActors", () => {
  it("builds the tenant-scoped search URL under /api (not /api/v1) with the query", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ actors: [] })),
    );

    await searchActors(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", query: "my" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten_1/actors/search?q=my`,
    );
  });

  it("forwards limit and URL-encodes the tenant id and query", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ actors: [] })),
    );

    await searchActors(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten/1", query: "a b", limit: 5 },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten%2F1/actors/search?q=a+b&limit=5`,
    );
  });

  it("returns parsed actors including status and optional email", async () => {
    const actors = [
      {
        id: "prn_u1",
        kind: "user",
        displayName: "Myra Ops",
        email: "myra@example.com",
        status: "active",
      },
      {
        id: "prn_a1",
        kind: "agent",
        displayName: "Oat",
        status: "deactivated",
      },
    ];
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ actors })),
    );

    const result = await searchActors(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", query: "o" },
    );

    expect(result).toEqual(actors as typeof result);
  });

  it("rejects a malformed response body", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ actors: [{ id: 1 }] })),
    );

    await expect(
      searchActors(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1", query: "my" },
      ),
    ).rejects.toThrow(/Invalid \/actors\/search response/);
  });

  it("surfaces the hub error message on a non-2xx response", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: "nope" }, 403)),
    );

    await expect(
      searchActors(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1", query: "my" },
      ),
    ).rejects.toThrow("nope");
  });
});

describe("getPrincipalActivity", () => {
  const entry = {
    kind: "message",
    id: "msg_1",
    sourceTable: "message",
    timestamp: "2026-07-01T12:00:00.000Z",
    summary: "hello",
  };

  it("builds the activity URL without params by default", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ entries: [], nextCursor: null })),
    );

    await getPrincipalActivity(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", principalId: "prn_1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten_1/principals/prn_1/activity`,
    );
  });

  it("forwards limit and cursor as query params", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ entries: [], nextCursor: null })),
    );

    await getPrincipalActivity(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", principalId: "prn_1", limit: 25, cursor: "abc=" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten_1/principals/prn_1/activity?limit=25&cursor=abc%3D`,
    );
  });

  it("parses a page of kind-discriminated entries and the next cursor", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ entries: [entry], nextCursor: "next-token" }),
      ),
    );

    const page = await getPrincipalActivity(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1", principalId: "prn_1" },
    );

    expect(page.nextCursor).toBe("next-token");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.kind).toBe("message");
    expect(page.entries[0]?.summary).toBe("hello");
  });

  it("rejects entries with an unknown kind", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({
          entries: [{ ...entry, kind: "mystery" }],
          nextCursor: null,
        }),
      ),
    );

    await expect(
      getPrincipalActivity(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1", principalId: "prn_1" },
      ),
    ).rejects.toThrow(/Invalid \/activity response/);
  });
});
