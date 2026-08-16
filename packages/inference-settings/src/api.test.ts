// The mint chain `shadowOffering` drives — model, then a credential
// (itself needing a credential-provider row), then the tenant-local
// model-provider, then the offering that references it — against a fake
// `fetch` that records every call. Covers three things the review called
// out: (1) the exact call order (model/credential steps before the
// model-provider, which is the step that re-routes every offering under
// that provider name — see api.ts's `shadowOffering` doc), (2) that every
// `ensure*` step, including the credential POST itself, tolerates a 409 by
// resolving the row that already exists rather than failing the whole
// flow, and (3) that a freshly-minted model-provider is rolled back
// (deleted) when the offering step that was meant to follow it fails.

import { afterEach, describe, expect, test } from "bun:test";

import { shadowOffering } from "./api";

const TENANT_ID = "tnt_1";
const NOW = "2026-01-01T00:00:00.000Z";

type Call = { readonly method: string; readonly path: string };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : new URL(String(input)).pathname;
}

const INPUT = {
  canonicalName: "claude-sonnet-5",
  modelDisplayName: "Claude Sonnet 5",
  providerName: "anthropic",
  plugin: "anthropic" as const,
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-test",
  priority: 2,
};

function modelResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "model_1",
    tenantId: TENANT_ID,
    canonicalName: INPUT.canonicalName,
    displayName: INPUT.modelDisplayName,
    disabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function credentialProviderResponse(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: "provider_1",
    tenantId: TENANT_ID,
    name: INPUT.providerName,
    plugin: INPUT.plugin,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function credentialResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "credential_1",
    tenantId: TENANT_ID,
    providerId: "provider_1",
    name: `${INPUT.providerName}-workbench`,
    type: "api_key",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function modelProviderResponse(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: "mp_1",
    tenantId: TENANT_ID,
    name: INPUT.providerName,
    plugin: INPUT.plugin,
    baseURL: INPUT.baseURL,
    credentialId: "credential_1",
    disabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function offeringResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "offering_1",
    tenantId: TENANT_ID,
    modelId: "model_1",
    providerId: "mp_1",
    priority: INPUT.priority,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function paginated(data: readonly unknown[]) {
  return { data, nextCursor: null };
}

describe("shadowOffering mint chain", () => {
  test("mints model, credential-provider, credential, model-provider, offering, in that order", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(modelResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        return Response.json(credentialProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        return Response.json(credentialResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        return Response.json(modelProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        return Response.json(offeringResponse(), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    const result = await shadowOffering(TENANT_ID, INPUT);

    expect(result.id).toBe("offering_1");
    // Model and credential steps run before the model-provider step: the
    // provider is the step that re-routes every inherited offering under
    // that provider name, so it happens last, right before the offering
    // that justifies it.
    expect(calls).toEqual([
      { method: "POST", path: `/api/tenants/${TENANT_ID}/catalog/models` },
      { method: "POST", path: `/api/tenants/${TENANT_ID}/providers` },
      { method: "POST", path: `/api/tenants/${TENANT_ID}/credentials` },
      {
        method: "POST",
        path: `/api/tenants/${TENANT_ID}/catalog/providers`,
      },
      {
        method: "POST",
        path: `/api/tenants/${TENANT_ID}/catalog/offerings`,
      },
    ]);
  });

  test("shadows at the exact priority of the offering being shadowed, not a row count", async () => {
    let offeringBody: unknown;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(modelResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        return Response.json(credentialProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        return Response.json(credentialResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        return Response.json(modelProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        offeringBody =
          init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
        return Response.json(offeringResponse(), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    await shadowOffering(TENANT_ID, { ...INPUT, priority: 7 });

    expect((offeringBody as { priority: number }).priority).toBe(7);
  });

  test("tolerates a 409 on every ensure* step, including the credential POST itself", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });

      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(paginated([modelResponse()]));
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(paginated([credentialProviderResponse()]));
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(paginated([credentialResponse()]));
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(paginated([modelProviderResponse()]));
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(
          paginated([
            offeringResponse({ modelId: "model_1", providerId: "mp_1" }),
          ]),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    const result = await shadowOffering(TENANT_ID, INPUT);

    expect(result.id).toBe("offering_1");
    // Every POST 409'd; every step fell back to its GET list and resolved
    // the existing row instead of throwing.
    const postCount = calls.filter((c) => c.method === "POST").length;
    const getCount = calls.filter((c) => c.method === "GET").length;
    expect(postCount).toBe(5);
    expect(getCount).toBe(5);
  });

  test("rolls back a freshly-minted model-provider when the offering step then fails", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });

      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(modelResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        return Response.json(credentialProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        return Response.json(credentialResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        if (method === "DELETE") return new Response(null, { status: 204 });
        return Response.json(modelProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers/mp_1`) {
        if (method === "DELETE") return new Response(null, { status: 204 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        return new Response(
          JSON.stringify({ error: { message: "server exploded" } }),
          { status: 500 },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    await expect(shadowOffering(TENANT_ID, INPUT)).rejects.toThrow();

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toEqual({
      method: "DELETE",
      path: `/api/tenants/${TENANT_ID}/catalog/providers/mp_1`,
    });
  });

  test("threads an explicit fetchImpl through every call, including the rollback DELETE, never touching the global fetch", async () => {
    globalThis.fetch = (() => {
      throw new Error("global fetch must not be called when fetchImpl is passed");
    }) as unknown as typeof fetch;

    const calls: Call[] = [];
    const fakeFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });

      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(modelResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        return Response.json(credentialProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        return Response.json(credentialResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        return Response.json(modelProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers/mp_1`) {
        if (method === "DELETE") return new Response(null, { status: 204 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        return new Response(
          JSON.stringify({ error: { message: "server exploded" } }),
          { status: 500 },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    await expect(
      shadowOffering(TENANT_ID, INPUT, fakeFetch),
    ).rejects.toThrow();

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toEqual({
      method: "DELETE",
      path: `/api/tenants/${TENANT_ID}/catalog/providers/mp_1`,
    });
  });

  test("does not roll back an already-existing model-provider (resolved via 409) when the offering step fails", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });

      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(modelResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/providers`) {
        return Response.json(credentialProviderResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/credentials`) {
        return Response.json(credentialResponse(), { status: 201 });
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        if (method === "POST") return new Response(null, { status: 409 });
        return Response.json(paginated([modelProviderResponse()]));
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        return new Response(
          JSON.stringify({ error: { message: "server exploded" } }),
          { status: 500 },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    await expect(shadowOffering(TENANT_ID, INPUT)).rejects.toThrow();

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
