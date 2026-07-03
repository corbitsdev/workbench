/// <reference types="bun" />
// Contract tests for the cache-baseline cost client fn (CL-2687): URL
// construction under the tenant-scoped `/api` prefix, query forwarding,
// boundary parsing through the exported arktype schema, and error paths.
import { describe, expect, it, mock } from "bun:test";
import "./test-setup";
import { getCacheBaseline, type CacheBaselineRow } from "./index";

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

const ROW: CacheBaselineRow = {
  agentId: "agt_myra",
  agentName: "Myra",
  inferenceCalls: 40,
  cacheMissCalls: 8,
  cacheHitCalls: 32,
  sessionCount: 12,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 9000,
  cacheWriteTokens: 300,
  cacheMissRate: 0.2,
  cacheAbsorptionRatio: 0.9,
};

describe("getCacheBaseline", () => {
  it("builds the tenant-scoped URL under /api (not /api/v1)", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ tenantId: "ten_1", agents: [] })),
    );

    await getCacheBaseline(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten_1/analytics/cache-baseline`,
    );
  });

  it("forwards range + scope query params and URL-encodes the tenant id", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ tenantId: "ten/1", agents: [] })),
    );

    await getCacheBaseline(
      { baseUrl: BASE, fetch: fetcher },
      {
        tenantId: "ten/1",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        agentId: "agt_x",
        instanceId: "ins_y",
      },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${BASE}/api/tenants/ten%2F1/analytics/cache-baseline?startDate=2026-06-01&endDate=2026-06-30&agentId=agt_x&instanceId=ins_y`,
    );
  });

  it("parses agents through the schema, including a null agentName", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({
          tenantId: "ten_1",
          agents: [ROW, { ...ROW, agentId: "agt_2", agentName: null }],
        }),
      ),
    );

    const rows = await getCacheBaseline(
      { baseUrl: BASE, fetch: fetcher },
      { tenantId: "ten_1" },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.cacheReadTokens).toBe(9000);
    expect(rows[1]?.agentName).toBeNull();
  });

  it("throws a boundary error when the response shape is invalid", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ tenantId: "ten_1", agents: [{ agentId: 5 }] }),
      ),
    );

    await expect(
      getCacheBaseline(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1" },
      ),
    ).rejects.toThrow(/Invalid \/cache-baseline response/);
  });

  it("surfaces a transport failure", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: "boom" }, 500)),
    );

    await expect(
      getCacheBaseline(
        { baseUrl: BASE, fetch: fetcher },
        { tenantId: "ten_1" },
      ),
    ).rejects.toThrow("boom");
  });
});
