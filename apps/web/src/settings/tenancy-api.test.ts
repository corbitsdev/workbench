// Regression coverage for the tenancy-api `requestVoid` seam (exercised
// through `removePrincipal`, which is the one delete route the People panel
// always hits): a literal 204 must be the only 2xx success, any other 2xx is
// a contract drift that fails loudly, and 401/403 map to their distinct errors
// (UnauthenticatedError / TenancyApiError-with-status) before the generic
// non-ok fallback runs.
import { afterEach, describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "@/lib/api-query";
import { removePrincipal, TenancyApiError } from "./tenancy-api";

const TENANT = "tenant-1";
const PRINCIPAL = "prn-1";
const REMOVE_PATH = `/api/tenants/${TENANT}/principals/${PRINCIPAL}`;

function stubFetch(status: number, body?: unknown): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tenancy-api removePrincipal (requestVoid)", () => {
  test("a literal 204 resolves", async () => {
    globalThis.fetch = stubFetch(204);
    await expect(removePrincipal(TENANT, PRINCIPAL)).resolves.toBeUndefined();
  });

  test("a 2xx other than 204 is a contract drift and fails loudly", async () => {
    globalThis.fetch = stubFetch(200, { ok: true });
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TenancyApiError);
    expect((error as TenancyApiError).status).toBe(200);
    expect((error as TenancyApiError).message).toContain("204");
  });

  test("a 201 is likewise rejected", async () => {
    globalThis.fetch = stubFetch(201, { created: true });
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TenancyApiError);
    expect((error as TenancyApiError).status).toBe(201);
  });

  test("a 401 maps to UnauthenticatedError", async () => {
    globalThis.fetch = stubFetch(401, {
      error: { code: "unauthorized", userMessage: "Sign in again", refId: "r" },
    });
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });

  test("a 403 maps to a statused TenancyApiError", async () => {
    globalThis.fetch = stubFetch(403, {
      error: { code: "forbidden", userMessage: "Not permitted", refId: "r" },
    });
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TenancyApiError);
    expect((error as TenancyApiError).status).toBe(403);
  });

  test("a generic 5xx still lands on the statused TenancyApiError", async () => {
    globalThis.fetch = stubFetch(500, {
      error: { code: "boom", userMessage: "Something broke", refId: "r" },
    });
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TenancyApiError);
    expect((error as TenancyApiError).status).toBe(500);
  });

  test("a network failure maps to a TenancyApiError with no status", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await removePrincipal(TENANT, PRINCIPAL).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TenancyApiError);
    expect((error as TenancyApiError).status).toBeUndefined();
  });
});
