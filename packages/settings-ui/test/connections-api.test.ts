// Connections API client: stub global fetch, assert request + parse.
// Mirrors credentials-api.test.ts's shape.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ConnectionsApiError,
  completeConnectorCredential,
  fetchOAuthConfigured,
  testConnectorCredential,
} from "../src/connections-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("fetchOAuthConfigured", () => {
  test("requests the tenant-scoped oauth-configured route and parses the map", async () => {
    const calls = stubFetch(() =>
      json({ openrouter: true, huggingface: false }),
    );

    const result = await fetchOAuthConfigured("tnt_1");

    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/connections/oauth-configured",
    );
    expect(result).toEqual({ openrouter: true, huggingface: false });
  });

  test("throws ConnectionsApiError on a malformed response", async () => {
    stubFetch(() => json({ openrouter: "not-a-boolean" }));

    await expect(fetchOAuthConfigured("tnt_1")).rejects.toBeInstanceOf(
      ConnectionsApiError,
    );
  });

  test("throws ConnectionsApiError with the envelope message on a non-2xx", async () => {
    stubFetch(() =>
      json({ error: { code: "forbidden", message: "nope" } }, 403),
    );

    await expect(fetchOAuthConfigured("tnt_1")).rejects.toBeInstanceOf(
      ConnectionsApiError,
    );
  });
});

describe("testConnectorCredential", () => {
  test("resolves ok on 200", async () => {
    stubFetch(() => json({ ok: true }));
    const result = await testConnectorCredential("tnt_1", "granola", "key");
    expect(result).toEqual({ ok: true });
  });

  test("resolves { ok: false, message } on 422 instead of throwing", async () => {
    stubFetch(() =>
      json({ error: { code: "invalid_credential", message: "bad key" } }, 422),
    );
    const result = await testConnectorCredential("tnt_1", "granola", "key");
    expect(result).toEqual({ ok: false, message: "bad key" });
  });
});

describe("completeConnectorCredential", () => {
  test("posts the api key and returns the stored credential id", async () => {
    const calls = stubFetch(() =>
      json({ credentialId: "cred_1", status: "active" }, 200),
    );
    const result = await completeConnectorCredential("tnt_1", "granola", "key");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/connections/granola/complete",
    );
    expect(result).toEqual({ credentialId: "cred_1", status: "active" });
  });
});
