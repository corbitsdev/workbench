/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";

// Pins the arktype boundary guard on GET /tenants/:id/providers and
// GET /tenants/:id/models (the Owner Models tab's native tenant API calls): a
// malformed payload must throw (fail-closed), never slip through. Fakes fetch
// so the real client fns + real schemas run end to end.
function fakeFetch(payload: unknown, status = 200) {
  return mock(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { getTenantProviders, getTenantModels } = await import("./hub-api");

const validProvidersResponse = {
  data: [{ id: "prov_1", name: "OpenAI", plugin: "openai" }],
  nextCursor: null,
};

const validModelsResponse = [
  {
    id: "model_1",
    canonicalName: "gpt-4o",
    displayName: "GPT-4o",
    description: null,
    offerings: [
      {
        offeringId: "off_1",
        providerId: "prov_1",
        providerName: "OpenAI",
        plugin: "openai",
        priority: 0,
      },
    ],
  },
];

describe("getTenantProviders boundary", () => {
  it("resolves a well-formed payload", async () => {
    globalThis.fetch = fakeFetch(validProvidersResponse) as typeof fetch;
    const providers = await getTenantProviders("ten_1");
    expect(providers).toEqual(validProvidersResponse.data);
  });

  it("throws when a provider is missing a required field", async () => {
    globalThis.fetch = fakeFetch({
      data: [{ id: "prov_1", plugin: "openai" }],
      nextCursor: null,
    }) as typeof fetch;
    await expect(getTenantProviders("ten_1")).rejects.toThrow();
  });

  it("throws when data is the wrong type", async () => {
    globalThis.fetch = fakeFetch({
      data: "not-an-array",
      nextCursor: null,
    }) as typeof fetch;
    await expect(getTenantProviders("ten_1")).rejects.toThrow();
  });
});

describe("getTenantModels boundary", () => {
  it("resolves a well-formed payload", async () => {
    globalThis.fetch = fakeFetch(validModelsResponse) as typeof fetch;
    const models = await getTenantModels("ten_1");
    expect(models).toEqual(validModelsResponse);
  });

  it("throws when offerings is the wrong type", async () => {
    globalThis.fetch = fakeFetch([
      { ...validModelsResponse[0], offerings: "OpenAI" },
    ]) as typeof fetch;
    await expect(getTenantModels("ten_1")).rejects.toThrow();
  });

  it("throws on a missing field", async () => {
    const { canonicalName: _omit, ...rest } = validModelsResponse[0]!;
    globalThis.fetch = fakeFetch([rest]) as typeof fetch;
    await expect(getTenantModels("ten_1")).rejects.toThrow();
  });
});
