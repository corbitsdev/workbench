// Access-policy API client: stub global fetch, assert request + parse, and
// that a fallback error never leaks the raw route to a person.

import { afterEach, describe, expect, test } from "bun:test";

import {
  AccessPolicyApiError,
  getAccessPolicy,
  updateAccessPolicy,
} from "../src/access-policy-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const policy = {
  selfSignup: "off" as const,
  allowedDomains: [],
  tenancyCreation: "owners" as const,
};

describe("getAccessPolicy", () => {
  test("fetches the tenant's access policy", async () => {
    let requestedPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedPath = String(input);
      return json(policy);
    }) as unknown as typeof fetch;

    const result = await getAccessPolicy("tnt_1");
    expect(requestedPath).toBe("/api/tenants/tnt_1/access-policy");
    expect(result).toEqual(policy);
  });

  test("prefers the server's envelope message on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      json(
        {
          error: {
            code: "forbidden",
            userMessage: "Not on this bench.",
            refId: "ref_1",
          },
        },
        403,
      )) as unknown as typeof fetch;

    await expect(getAccessPolicy("tnt_1")).rejects.toMatchObject({
      message: "Not on this bench.",
    });
  });

  test("falls back to a path-free message when there is no envelope", async () => {
    globalThis.fetch = (async () =>
      json(undefined, 401)) as unknown as typeof fetch;

    try {
      await getAccessPolicy("tnt_1");
      throw new Error("expected getAccessPolicy to reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AccessPolicyApiError);
      expect((cause as Error).message).toBe(
        "The server answered 401 while loading who can join.",
      );
      expect((cause as Error).message).not.toContain("/api/");
    }
  });
});

describe("updateAccessPolicy", () => {
  test("PATCHes the given fields", async () => {
    let requestedBody: unknown;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestedBody =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      return json(policy);
    }) as unknown as typeof fetch;

    await updateAccessPolicy("tnt_1", { selfSignup: "open" });
    expect(requestedBody).toEqual({ selfSignup: "open" });
  });
});
