import { describe, expect, test } from "bun:test";

import {
  fetchChain,
  listConcepts,
  type CatalogToolClientConfig,
} from "./client";

const CHAIN_BODY = {
  concept: "cheap-loop",
  requiredCapabilities: ["plain-text"],
  entries: [
    {
      canonicalName: "thrifty",
      displayName: "Thrifty",
      providerName: "globex",
      plugin: "openai-compatible",
      offeringId: "off_1",
      capabilities: ["plain-text"],
      price: {
        currency: "USD",
        known: true,
        inputUsdPerMTok: 0.1,
        outputUsdPerMTok: 0.4,
      },
      referenceCostUsd: 0.12,
      overCeiling: false,
    },
  ],
  note: null,
};

function config(fetchImpl: typeof fetch): CatalogToolClientConfig {
  return {
    hubCatalogUrl: "https://hub.example.com",
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
      return new Response(JSON.stringify(CHAIN_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchChain(config(fetchImpl), { concept: "cheap-loop" });

    expect(seen?.url).toBe(
      "https://hub.example.com/api/workflow-inference-catalog/chain",
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
            message: '"jazz" is not a kind of work',
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    await expect(
      fetchChain(config(fetchImpl), { concept: "jazz" }),
    ).rejects.toThrow("is not a kind of work");
  });

  test("a body in an unexpected shape is an error, not a half-parsed answer", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ entries: "lots" }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      fetchChain(config(fetchImpl), { concept: "cheap-loop" }),
    ).rejects.toThrow("unexpected shape");
  });

  test("an unreachable hub is an error, never an empty list", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(listConcepts(config(fetchImpl))).rejects.toThrow(
      "connection refused",
    );
  });
});
