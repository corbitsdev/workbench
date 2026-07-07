/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";

// Pins the arktype boundary guard on GET /owner/context: a malformed payload
// must throw (fail-closed), never slip through as a cast. Fakes `fetch` so the
// real `getOwnerContext` + real `OwnerContextResponse` schema run end to end.
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

const { getOwnerContext } = await import("./hub-api");

describe("getOwnerContext boundary", () => {
  it("resolves a well-formed payload", async () => {
    globalThis.fetch = fakeFetch({
      tenantId: "ten_1",
      ownerPrincipalId: "prn_1",
    }) as typeof fetch;
    const ctx = await getOwnerContext();
    expect(ctx.tenantId).toBe("ten_1");
    expect(ctx.ownerPrincipalId).toBe("prn_1");
  });

  it("throws on a missing field (does not slip through)", async () => {
    globalThis.fetch = fakeFetch({ tenantId: "ten_1" }) as typeof fetch;
    await expect(getOwnerContext()).rejects.toThrow();
  });

  it("throws on a wrong-typed field", async () => {
    globalThis.fetch = fakeFetch({
      tenantId: 123,
      ownerPrincipalId: "prn_1",
    }) as typeof fetch;
    await expect(getOwnerContext()).rejects.toThrow();
  });
});
