import { afterEach, describe, expect, test } from "bun:test";

import {
  createProviderHealthPort,
  createProviderHealthStore,
  fetchProviderHealth,
  isClassifiedInferenceFailure,
} from "./provider-health";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isClassifiedInferenceFailure", () => {
  test("credential_failure and quota_exhausted are classified", () => {
    expect(isClassifiedInferenceFailure("credential_failure")).toBe(true);
    expect(isClassifiedInferenceFailure("quota_exhausted")).toBe(true);
  });

  test("every other InferenceError category is not classified", () => {
    for (const category of [
      "context_overflow",
      "retryable",
      "fatal",
      "aborted",
      "timeout",
      "protocol_mismatch",
    ]) {
      expect(isClassifiedInferenceFailure(category)).toBe(false);
    }
  });
});

describe("createProviderHealthStore", () => {
  test("report marks a provider needs_attention with the given reason and time", () => {
    const store = createProviderHealthStore(() => new Date("2026-08-15T00:00:00.000Z"));
    store.report("bench_1", "anthropic", "credential error");
    expect(store.get("bench_1", "anthropic")).toEqual({
      status: "needs_attention",
      reason: "credential error",
      at: "2026-08-15T00:00:00.000Z",
    });
  });

  test("a provider with no reported failure has no record", () => {
    const store = createProviderHealthStore();
    expect(store.get("bench_1", "anthropic")).toBeUndefined();
  });

  test("clear removes the record — only a passing re-test should call it", () => {
    const store = createProviderHealthStore();
    store.report("bench_1", "anthropic", "credential error");
    store.clear("bench_1", "anthropic");
    expect(store.get("bench_1", "anthropic")).toBeUndefined();
  });

  test("clearing a provider with no record is a no-op", () => {
    const store = createProviderHealthStore();
    expect(() => store.clear("bench_1", "anthropic")).not.toThrow();
  });

  test("a later report overwrites an earlier one for the same provider", () => {
    const store = createProviderHealthStore(() => new Date("2026-08-15T00:00:00.000Z"));
    store.report("bench_1", "anthropic", "first reason");
    store.report("bench_1", "anthropic", "second reason");
    expect(store.get("bench_1", "anthropic")?.reason).toBe("second reason");
  });

  test("records are scoped per tenant", () => {
    const store = createProviderHealthStore();
    store.report("bench_1", "anthropic", "credential error");
    expect(store.get("bench_2", "anthropic")).toBeUndefined();
  });

  test("listForTenant returns every unhealthy provider for that tenant", () => {
    const store = createProviderHealthStore();
    store.report("bench_1", "anthropic", "credential error");
    store.report("bench_1", "openai", "quota exhausted");
    store.report("bench_2", "xai", "credential error");
    expect(Object.keys(store.listForTenant("bench_1")).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  test("listForTenant is empty for a tenant with no records", () => {
    const store = createProviderHealthStore();
    expect(store.listForTenant("bench_1")).toEqual({});
  });
});

describe("createProviderHealthPort", () => {
  test("reportInferenceFailure writes through to the underlying store", () => {
    const store = createProviderHealthStore();
    const port = createProviderHealthPort(store);
    port.reportInferenceFailure({
      tenantId: "bench_1",
      provider: "anthropic",
      reason: "credential error",
    });
    expect(store.get("bench_1", "anthropic")?.status).toBe("needs_attention");
  });
});

describe("fetchProviderHealth", () => {
  test("GETs the tenant-scoped provider-health route and returns its body", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input: string) => {
      requestedUrl = input;
      return new Response(
        JSON.stringify({
          providers: {
            anthropic: {
              status: "needs_attention",
              reason: "credential error",
              at: "2026-08-15T00:00:00.000Z",
            },
          },
          connectedProviderCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const snapshot = await fetchProviderHealth("bench_1");
    expect(requestedUrl).toBe(
      "/api/tenants/bench_1/connections/provider-health",
    );
    expect(snapshot.connectedProviderCount).toBe(1);
    expect(snapshot.providers["anthropic"]?.reason).toBe("credential error");
  });

  test("throws on a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(fetchProviderHealth("bench_1")).rejects.toThrow();
  });
});
