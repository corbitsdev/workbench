// Regression coverage for the inference/api `requestVoid` seam (exercised
// through `deleteOwnOffering`, the one database-less void route the Inference
// section calls, which also proves the `fetchImpl` seam is honored): a literal
// 204 must be the only 2xx success, any other 2xx is a contract drift that
// fails loudly, and the cardinal error envelope is surfaced with its status.
import { beforeEach, describe, expect, test } from "bun:test";

import { deleteOwnOffering, InferenceSettingsApiError } from "./api";

const TENANT = "tenant-1";
const OFFERING = "offering-1";

type StubCall = { readonly input: string | URL | Request; readonly init: RequestInit | undefined };
const calls: StubCall[] = [];

function stubFetch(status: number, body?: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});

describe("inference/api deleteOwnOffering (requestVoid)", () => {
  test("a literal 204 resolves", async () => {
    await expect(deleteOwnOffering(TENANT, OFFERING, stubFetch(204))).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  test("a 2xx other than 204 is a contract drift and fails loudly", async () => {
    const error = await deleteOwnOffering(TENANT, OFFERING, stubFetch(200, { ok: true })).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBe(200);
    expect((error as InferenceSettingsApiError).message).toContain("204");
  });

  test("a 201 is likewise rejected", async () => {
    const error = await deleteOwnOffering(
      TENANT,
      OFFERING,
      stubFetch(201, { created: true }),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBe(201);
  });

  test("a 401 surfaces the envelope's userMessage with the status", async () => {
    const error = await deleteOwnOffering(
      TENANT,
      OFFERING,
      stubFetch(401, {
        error: { code: "unauthorized", userMessage: "Sign in again", refId: "r" },
      }),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBe(401);
    expect((error as InferenceSettingsApiError).message).toBe("Sign in again");
  });

  test("a 403 surfaces the envelope's userMessage with the status", async () => {
    const error = await deleteOwnOffering(
      TENANT,
      OFFERING,
      stubFetch(403, {
        error: { code: "forbidden", userMessage: "Not permitted", refId: "r" },
      }),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBe(403);
    expect((error as InferenceSettingsApiError).message).toBe("Not permitted");
  });

  test("a 5xx falls back to a generic path-free sentence", async () => {
    const error = await deleteOwnOffering(
      TENANT,
      OFFERING,
      stubFetch(500, { notAnEnvelope: true }),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBe(500);
  });

  test("a network failure maps to an InferenceSettingsApiError", async () => {
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await deleteOwnOffering(TENANT, OFFERING, throwing).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(InferenceSettingsApiError);
    expect((error as InferenceSettingsApiError).status).toBeUndefined();
  });
});
