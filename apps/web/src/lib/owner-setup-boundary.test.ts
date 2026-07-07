/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";

// Pins the arktype boundary guard on GET /owner/setup: a malformed payload must
// throw (fail-closed), never slip through. Fakes fetch so the real
// getOwnerSetup + real OwnerSetupResponse schema run end to end.
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

const { getOwnerSetup } = await import("./hub-api");

const valid = {
  tenantId: "ten_1",
  tenantName: "Acme",
  tenantSlug: "acme",
  parentTenantId: null,
  deployedWorkflowKinds: ["brief-builder"],
};

describe("getOwnerSetup boundary", () => {
  it("resolves a well-formed payload", async () => {
    globalThis.fetch = fakeFetch(valid) as typeof fetch;
    const s = await getOwnerSetup();
    expect(s.tenantName).toBe("Acme");
    expect(s.deployedWorkflowKinds).toEqual(["brief-builder"]);
  });

  it("throws when deployedWorkflowKinds is the wrong type", async () => {
    globalThis.fetch = fakeFetch({
      ...valid,
      deployedWorkflowKinds: "brief-builder",
    }) as typeof fetch;
    await expect(getOwnerSetup()).rejects.toThrow();
  });

  it("throws on a missing field", async () => {
    const { tenantName: _omit, ...rest } = valid;
    globalThis.fetch = fakeFetch(rest) as typeof fetch;
    await expect(getOwnerSetup()).rejects.toThrow();
  });
});
