// Unit tests for the unified fetch + ArkType client request layer (`apiRequest`,
// `requestVoid`, `apiQueryOptions`, and the shared `ApiQueryError` subclass
// hierarchy across settings, tenancy, credentials, inference, and chat seams).
import { afterEach, describe, expect, test } from "bun:test";
import { type } from "arktype";

import { ApiQueryError, UnauthenticatedError } from "@/lib/api-query";
import { apiQueryOptions, fetchArtifactDetail, fetchTenantDetail } from "./api";
import { ChatApiError } from "./chat/threads-api";
import { shouldRetryQuery, isAuthInvalidError } from "./query-client";
import { apiRequest, readErrorEnvelope, requestVoid } from "./settings/api-request";
import { SettingsApiError, getAccount } from "./settings/api";
import { CredentialsApiError, deleteCredential } from "./settings/credentials-api";
import { InferenceSettingsApiError, deleteOwnOffering } from "./settings/inference/api";
import { TenancyApiError, removePrincipal } from "./settings/tenancy-api";

const ItemSchema = type({ id: "string", count: "number" });

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

describe("Error hierarchy — all API errors extend ApiQueryError", () => {
  test("domain API error classes are instanceof both their own class and ApiQueryError", () => {
    const errors = [
      new SettingsApiError("settings fail", 500),
      new TenancyApiError("tenancy fail", 404),
      new CredentialsApiError("cred fail", 403),
      new InferenceSettingsApiError("inference fail", 401),
      new ChatApiError("chat fail", 502),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ApiQueryError);
    }

    expect(errors[0]).toBeInstanceOf(SettingsApiError);
    expect(errors[1]).toBeInstanceOf(TenancyApiError);
    expect(errors[2]).toBeInstanceOf(CredentialsApiError);
    expect(errors[3]).toBeInstanceOf(InferenceSettingsApiError);
    expect(errors[4]).toBeInstanceOf(ChatApiError);
  });

  test("shouldRetryQuery and isAuthInvalidError recognize domain error subclasses via ApiQueryError", () => {
    const notFound = new TenancyApiError("missing", 404);
    expect(shouldRetryQuery(0, notFound)).toBe(false);

    const serverErr = new CredentialsApiError("boom", 500);
    expect(shouldRetryQuery(0, serverErr)).toBe(true);
    expect(shouldRetryQuery(3, serverErr)).toBe(false);

    const unauth = new InferenceSettingsApiError("expired", 401);
    expect(isAuthInvalidError(unauth)).toBe(true);
    expect(isAuthInvalidError(notFound)).toBe(false);
  });
});

describe("readErrorEnvelope", () => {
  test("extracts userMessage from cardinal error envelope", () => {
    const msg = readErrorEnvelope(
      403,
      { error: { code: "forbidden", userMessage: "Access denied.", refId: "ref-1" } },
      "saving settings",
    );
    expect(msg).toBe("Access denied.");
  });

  test("extracts message from stock hub error envelope when userMessage is absent", () => {
    const msg = readErrorEnvelope(
      400,
      { error: { code: "bad_request", message: "Invalid skill name." } },
      "creating skill",
    );
    expect(msg).toBe("Invalid skill name.");
  });

  test("falls back to path-free sentence when body is not a recognized envelope", () => {
    expect(readErrorEnvelope(502, { unexpected: true }, "loading data")).toBe(
      "The server answered 502 while loading data.",
    );
    expect(readErrorEnvelope(502, undefined)).toBe("The server answered 502.");
  });
});

describe("apiRequest and requestVoid", () => {
  test("parses valid response through ArkType schema", async () => {
    const value = await apiRequest(
      "/api/items/1",
      ItemSchema,
      "loading item",
      ApiQueryError,
      undefined,
      stubFetch(200, { id: "item-1", count: 42 }),
    );
    expect(value).toEqual({ id: "item-1", count: 42 });
  });

  test("rejects with statused ErrorCtor on non-2xx and surfaces envelope userMessage", async () => {
    const error = await apiRequest(
      "/api/items/1",
      ItemSchema,
      "loading item",
      CredentialsApiError,
      undefined,
      stubFetch(403, {
        error: { code: "forbidden", userMessage: "No permission", refId: "r-1" },
      }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CredentialsApiError);
    expect(error).toBeInstanceOf(ApiQueryError);
    expect((error as CredentialsApiError).status).toBe(403);
    expect((error as CredentialsApiError).message).toBe("No permission");
  });

  test("rejects when response body fails ArkType schema validation", async () => {
    const error = await apiRequest(
      "/api/items/1",
      ItemSchema,
      "loading item",
      SettingsApiError,
      undefined,
      stubFetch(200, { id: "item-1", count: "not-a-number" }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SettingsApiError);
    expect(error).toBeInstanceOf(ApiQueryError);
    expect((error as SettingsApiError).message).toContain("Unexpected response shape");
  });

  test("requestVoid resolves on 204 and rejects on 200 or network error", async () => {
    await expect(
      requestVoid(
        "/api/items/1",
        "deleting item",
        CredentialsApiError,
        { method: "DELETE" },
        stubFetch(204),
      ),
    ).resolves.toBeUndefined();

    const drift = await requestVoid(
      "/api/items/1",
      "deleting item",
      CredentialsApiError,
      { method: "DELETE" },
      stubFetch(200, { ok: true }),
    ).catch((cause: unknown) => cause);
    expect(drift).toBeInstanceOf(CredentialsApiError);
    expect(drift).toBeInstanceOf(ApiQueryError);
    expect((drift as CredentialsApiError).status).toBe(200);
  });

  test("apiQueryOptions maps 401 to UnauthenticatedError and non-ok to ApiQueryError", async () => {
    globalThis.fetch = stubFetch(401, {});
    const opts = apiQueryOptions("/api/me", ItemSchema);
    const unauth = await opts.queryFn().catch((cause: unknown) => cause);
    expect(unauth).toBeInstanceOf(UnauthenticatedError);

    globalThis.fetch = stubFetch(503, {});
    const serverErr = await opts.queryFn().catch((cause: unknown) => cause);
    expect(serverErr).toBeInstanceOf(ApiQueryError);
    expect((serverErr as ApiQueryError).status).toBe(503);
  });

  test("settings, tenancy, credentials, inference, and api helpers preserve error contracts", async () => {
    globalThis.fetch = stubFetch(401, {});
    await expect(getAccount()).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(removePrincipal("t1", "p1")).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(fetchTenantDetail("t1")).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(fetchArtifactDetail("t1", "a1")).rejects.toBeInstanceOf(UnauthenticatedError);

    globalThis.fetch = stubFetch(500, {});
    const credErr = await deleteCredential("t1", "c1").catch((cause: unknown) => cause);
    expect(credErr).toBeInstanceOf(CredentialsApiError);
    expect(credErr).toBeInstanceOf(ApiQueryError);

    const infErr = await deleteOwnOffering("t1", "o1", stubFetch(500, {})).catch(
      (cause: unknown) => cause,
    );
    expect(infErr).toBeInstanceOf(InferenceSettingsApiError);
    expect(infErr).toBeInstanceOf(ApiQueryError);
  });
});
