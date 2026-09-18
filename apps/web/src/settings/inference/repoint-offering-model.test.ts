// `repointOfferingModel` is a non-obvious two-step (ensure model, then
// delete+recreate the offering) because the stock offering PATCH has no
// `modelId` field and a model's `canonicalName` is immutable — see
// api.ts's doc on the function. Covers the two cases that make it
// non-trivial: a same-name edit is a no-op (no DELETE/POST at all), and a
// real change carries the offering's priority over to the new row.

import { afterEach, describe, expect, test } from "bun:test";

import { repointOfferingModel } from "./api";

const TENANT_ID = "tnt_1";
const NOW = "2026-01-01T00:00:00.000Z";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : new URL(String(input)).pathname;
}

const OFFERING = {
  id: "offering_1",
  tenantId: TENANT_ID,
  modelId: "model_1",
  providerId: "provider_1",
  priority: 5,
  deploymentTags: [],
  capabilities: [],
  quirks: null,
  disabled: false,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("repointOfferingModel", () => {
  test("is a no-op when the canonical name resolves to the offering's own model", async () => {
    const calls: { method: string; path: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = pathOf(input);
      calls.push({ method, path });
      // ensureModel's create attempt conflicts; it already exists as model_1.
      if (method === "POST" && path.endsWith("/catalog/models")) {
        return new Response(null, { status: 409 });
      }
      if (method === "GET" && path.endsWith("/catalog/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "model_1",
                tenantId: TENANT_ID,
                canonicalName: "qwen2.5:14b",
                displayName: "qwen2.5:14b",
                disabled: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    }) as typeof fetch;

    const result = await repointOfferingModel(TENANT_ID, OFFERING, "qwen2.5:14b", "qwen2.5:14b");

    expect(result).toBe(OFFERING);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("deletes the old offering and recreates it at the same priority for a new model", async () => {
    const calls: { method: string; path: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = pathOf(input);
      calls.push({ method, path });
      if (method === "POST" && path.endsWith("/catalog/models")) {
        return new Response(
          JSON.stringify({
            id: "model_2",
            tenantId: TENANT_ID,
            canonicalName: "qwen2.5:32b",
            displayName: "qwen2.5:32b",
            disabled: false,
            createdAt: NOW,
            updatedAt: NOW,
          }),
          { status: 201 },
        );
      }
      if (method === "DELETE" && path.endsWith(`/catalog/offerings/${OFFERING.id}`)) {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path.endsWith("/catalog/offerings")) {
        const body = JSON.parse(String(init?.body)) as { modelId: string; priority: number };
        return new Response(
          JSON.stringify({
            ...OFFERING,
            id: "offering_2",
            modelId: body.modelId,
            priority: body.priority,
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    }) as typeof fetch;

    const result = await repointOfferingModel(TENANT_ID, OFFERING, "qwen2.5:32b", "qwen2.5:32b");

    expect(result.modelId).toBe("model_2");
    expect(result.priority).toBe(OFFERING.priority);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "POST"]);
  });
});
