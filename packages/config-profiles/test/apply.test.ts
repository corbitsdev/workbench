// Integration coverage for `applyProfile`: the exact `fetch` calls it
// issues against a fake fetch, in order — the write-sequence contract the
// task calls out explicitly (never `Promise.all`, always the profile's
// own entry order).
import { describe, expect, test } from "bun:test";

import { applyProfile, ConfigProfileNotFoundError } from "../src/apply";
import { createInMemoryConfigProfileStore } from "../src/store";

type Call = {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
};

function fakeFetch(responses: { models: unknown; ownOfferings: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (method === "GET" && url.endsWith("/models")) {
      return new Response(JSON.stringify(responses.models), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.endsWith("/catalog/offerings")) {
      return new Response(
        JSON.stringify({ data: responses.ownOfferings, nextCursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "PATCH" && url.includes("/catalog/offerings/")) {
      const offeringId = url.split("/").pop();
      return new Response(
        JSON.stringify({
          id: offeringId,
          tenantId: "wbn_1",
          modelId: "mdl_1",
          providerId: "prv_1",
          priority: (body as { priority: number }).priority,
          deploymentTags: [],
          capabilities: [],
          quirks: null,
          disabled: (body as { disabled: boolean }).disabled,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const models = [
  {
    id: "mdl_1",
    canonicalName: "gpt-5",
    offerings: [
      {
        offeringId: "ofr_openai",
        providerId: "prv_openai",
        providerName: "OpenAI",
        plugin: "openai",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
      {
        offeringId: "ofr_azure",
        providerId: "prv_azure",
        providerName: "Azure",
        plugin: "openai",
        priority: 1,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
];

const ownOfferings = [
  {
    id: "ofr_openai",
    tenantId: "wbn_1",
    modelId: "mdl_1",
    providerId: "prv_openai",
    priority: 0,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "ofr_azure",
    tenantId: "wbn_1",
    modelId: "mdl_1",
    providerId: "prv_azure",
    priority: 1,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("applyProfile", () => {
  test("issues one PATCH per reordered entry, in the profile's own order, after the two resolve reads", async () => {
    const store = createInMemoryConfigProfileStore();
    const profile = await store.createProfile({
      tenantId: "tnt_workspace",
      name: "Azure first",
      entries: [
        { provider: "Azure", model: "gpt-5" },
        { provider: "OpenAI", model: "gpt-5" },
      ],
      createdBy: "prn_1",
    });

    const { fetchImpl, calls } = fakeFetch({ models, ownOfferings });
    const result = await applyProfile(
      { store },
      {
        tenantId: "tnt_workspace",
        profileId: profile.id,
        workbenchTenantId: "wbn_1",
        fetchImpl,
      },
    );

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/tenants/wbn_1/models",
      "GET /api/tenants/wbn_1/catalog/offerings",
      "PATCH /api/tenants/wbn_1/catalog/offerings/ofr_azure",
      "PATCH /api/tenants/wbn_1/catalog/offerings/ofr_openai",
    ]);
    expect(calls[2]?.body).toEqual({ priority: 0, disabled: false });
    expect(calls[3]?.body).toEqual({ priority: 1, disabled: false });
    expect(result.results).toEqual([
      {
        provider: "Azure",
        model: "gpt-5",
        action: "reordered",
        offeringId: "ofr_azure",
        priority: 0,
        disabled: false,
      },
      {
        provider: "OpenAI",
        model: "gpt-5",
        action: "reordered",
        offeringId: "ofr_openai",
        priority: 1,
        disabled: false,
      },
    ]);
  });

  test("an inherited-only entry is reported skipped-inherited and never PATCHed", async () => {
    const store = createInMemoryConfigProfileStore();
    const profile = await store.createProfile({
      tenantId: "tnt_workspace",
      name: "Azure only",
      entries: [{ provider: "Azure", model: "gpt-5" }],
      createdBy: "prn_1",
    });
    // Neither offering is "own" here — both resolve as inherited.
    const { fetchImpl, calls } = fakeFetch({ models, ownOfferings: [] });
    const result = await applyProfile(
      { store },
      {
        tenantId: "tnt_workspace",
        profileId: profile.id,
        workbenchTenantId: "wbn_1",
        fetchImpl,
      },
    );
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(result.results).toEqual([
      { provider: "Azure", model: "gpt-5", action: "skipped-inherited" },
    ]);
  });

  test("throws ConfigProfileNotFoundError for an unknown profile id, before any fetch", async () => {
    const store = createInMemoryConfigProfileStore();
    const { fetchImpl, calls } = fakeFetch({ models: [], ownOfferings: [] });
    await expect(
      applyProfile(
        { store },
        {
          tenantId: "tnt_workspace",
          profileId: "does_not_exist",
          workbenchTenantId: "wbn_1",
          fetchImpl,
        },
      ),
    ).rejects.toBeInstanceOf(ConfigProfileNotFoundError);
    expect(calls).toEqual([]);
  });
});
