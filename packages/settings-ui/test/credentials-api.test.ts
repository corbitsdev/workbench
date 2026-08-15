// Credentials API client: stub global fetch, assert request + parse.

import { afterEach, describe, expect, test } from "bun:test";

import {
  CredentialsApiError,
  createCredential,
  deleteCredential,
  listCredentials,
  listProviders,
} from "../src/credentials-api";

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

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const credentialRow = {
  id: "cred_1",
  tenantId: "tnt_1",
  providerId: "prov_1",
  name: "OpenAI",
  type: "api_key" as const,
  status: "active" as const,
  ...timestamps,
};

const providerRow = {
  id: "prov_1",
  tenantId: "tnt_1",
  name: "OpenAI",
  plugin: "openai",
  ...timestamps,
};

describe("listCredentials", () => {
  test("fetches the tenant's credentials page", async () => {
    const calls = stubFetch(() =>
      json({ data: [credentialRow], nextCursor: null }),
    );
    const rows = await listCredentials("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/credentials");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("OpenAI");
  });

  test("throws CredentialsApiError on 403", async () => {
    stubFetch(() => json({ error: "nope" }, 403));
    await expect(listCredentials("tnt_1")).rejects.toBeInstanceOf(
      CredentialsApiError,
    );
  });

  test("a fallback error message never leaks the raw route", async () => {
    stubFetch(() => json(undefined, 401));
    try {
      await listCredentials("tnt_1");
      throw new Error("expected listCredentials to reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CredentialsApiError);
      expect((cause as Error).message).not.toContain("/api/");
      expect((cause as Error).message).toBe(
        "The server answered 401 while loading credentials.",
      );
    }
  });
});

describe("listProviders", () => {
  test("fetches the tenant's providers page", async () => {
    const calls = stubFetch(() =>
      json({ data: [providerRow], nextCursor: null }),
    );
    const rows = await listProviders("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/providers");
    expect(rows[0]?.plugin).toBe("openai");
  });
});

describe("createCredential", () => {
  test("POSTs provider, name, type, and secret", async () => {
    const calls = stubFetch(() => json(credentialRow, 201));
    const created = await createCredential("tnt_1", {
      providerId: "prov_1",
      name: "OpenAI",
      type: "api_key",
      secret: "sk-test",
    });
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/credentials");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      secret: string;
      providerId: string;
    };
    expect(body.secret).toBe("sk-test");
    expect(body.providerId).toBe("prov_1");
    expect(created.id).toBe("cred_1");
  });
});

describe("deleteCredential", () => {
  test("DELETEs the credential id", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await deleteCredential("tnt_1", "cred_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/credentials/cred_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});
