// Connections API client: stub global fetch, assert request + parse.
// Mirrors credentials-api.test.ts's shape.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ConnectionsApiError,
  completeConnectorCredential,
  disconnectConnector,
  fetchOAuthConfigured,
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

  test("falls back to a path-free message when the body has no envelope", async () => {
    stubFetch(() => json(undefined, 401));
    try {
      await fetchOAuthConfigured("tnt_1");
      throw new Error("expected fetchOAuthConfigured to reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConnectionsApiError);
      expect((cause as Error).message).toBe(
        "The server answered 401 while loading connection status.",
      );
      expect((cause as Error).message).not.toContain("/api/");
    }
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

  // CL-6682: a key copied from a provider console often carries a
  // trailing newline; sent verbatim it 401s a perfectly valid key.
  test("strips leading/trailing whitespace from the pasted key", async () => {
    const calls = stubFetch(() =>
      json({ credentialId: "cred_1", status: "active" }, 200),
    );
    await completeConnectorCredential("tnt_1", "granola", " sk-good\n");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ apiKey: "sk-good" });
  });

  // CL-6377: connecting is the one round-trip — a rejected key throws
  // straight from this call, with no separate test step beforehand.
  test("throws ConnectionsApiError with the probe's own message on a 422", async () => {
    stubFetch(() =>
      json(
        {
          error: {
            code: "invalid_credential",
            userMessage: "bad key",
            refId: "ref_1",
          },
        },
        422,
      ),
    );
    await expect(
      completeConnectorCredential("tnt_1", "granola", "key"),
    ).rejects.toThrow("bad key");
  });
});

describe("disconnectConnector", () => {
  test("DELETEs the connector's disconnect route", async () => {
    const calls = stubFetch(() => json(undefined, 204));
    await disconnectConnector("tnt_1", "granola");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/connections/granola/disconnect",
    );
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("throws ConnectionsApiError with the envelope message on a non-2xx", async () => {
    stubFetch(() =>
      json(
        {
          error: {
            code: "disconnect_failed",
            userMessage: "try again",
            refId: "ref_1",
          },
        },
        500,
      ),
    );
    await expect(disconnectConnector("tnt_1", "granola")).rejects.toThrow(
      "try again",
    );
  });
});
