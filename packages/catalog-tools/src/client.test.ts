import { describe, expect, test } from "bun:test";

import {
  fetchCatalog,
  fetchModelPolicy,
  type CatalogToolClientConfig,
} from "./client";

const MODELS_BODY = [
  {
    id: "m1",
    canonicalName: "thrifty",
    displayName: "Thrifty",
    offerings: [
      {
        offeringId: "off_1",
        providerName: "globex",
        plugin: "openai-compatible",
        priority: 0,
        capabilities: ["plain-text"],
        pricing: [
          {
            offeringId: "off_1",
            currency: "USD",
            inputTokenPrice: "0.0000001",
            outputTokenPrice: "0.0000004",
          },
        ],
      },
    ],
  },
];

function config(fetchImpl: typeof fetch): CatalogToolClientConfig {
  return {
    hubCatalogUrl: "https://hub.example.com",
    tenantId: "bench_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

describe("catalog tool client", () => {
  test("carries the sidecar token and run address on every call", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response(JSON.stringify(MODELS_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchCatalog(config(fetchImpl));

    expect(seen?.url).toBe(
      "https://hub.example.com/api/tenants/bench_1/models",
    );
    expect(seen?.headers.get("authorization")).toBe("Bearer sc-token");
    expect(seen?.headers.get("x-workflow-run-address")).toBe("run_1@workflow");
  });

  test("a refusal from the hub surfaces its own message", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            userMessage: "the bench is not reachable",
            refId: "ref_test",
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    await expect(fetchCatalog(config(fetchImpl))).rejects.toThrow(
      "the bench is not reachable",
    );
  });

  test("a body in an unexpected shape is an error, not a half-parsed answer", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ not: "a model list" }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(fetchCatalog(config(fetchImpl))).rejects.toThrow(
      "unexpected shape",
    );
  });

  test("an unreachable hub is an error, never an empty list", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(fetchCatalog(config(fetchImpl))).rejects.toThrow(
      "connection refused",
    );
  });

  test("reads the model policy out of the tenant's own config blob", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: "bench_1",
          config: { corbits: { modelPolicy: { deny: ["acme/alpha"] } } },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const policy = await fetchModelPolicy(config(fetchImpl));
    expect(policy.deny).toEqual(["acme/alpha"]);
  });

  test("a bench with no config blob reads as the empty policy", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "bench_1" }), {
        status: 200,
      })) as unknown as typeof fetch;

    const policy = await fetchModelPolicy(config(fetchImpl));
    expect(policy.allow).toEqual([]);
    expect(policy.deny).toEqual([]);
  });
});
