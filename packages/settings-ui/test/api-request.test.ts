// The envelope-first error message every settings-ui API seam now shares:
// the hub's own `{error:{message}}` wins, and the fallback never leaks the
// raw route to a person reading the settings surface.

import { describe, expect, test } from "bun:test";

import { apiRequest, readErrorEnvelope } from "../src/api-request";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

describe("readErrorEnvelope", () => {
  test("prefers the server's own envelope message", () => {
    expect(
      readErrorEnvelope(
        403,
        { error: { code: "forbidden", message: "Not on this bench." } },
        "loading credentials",
      ),
    ).toBe("Not on this bench.");
  });

  test("falls back to a path-free sentence naming the status and the verb", () => {
    const message = readErrorEnvelope(401, undefined, "loading credentials");
    expect(message).toBe("The server answered 401 while loading credentials.");
    expect(message).not.toContain("/api/");
  });

  test("falls back when the body has no usable envelope shape", () => {
    expect(
      readErrorEnvelope(500, { error: "boom" }, "saving that connection"),
    ).toBe("The server answered 500 while saving that connection.");
  });
});

describe("apiRequest", () => {
  const realFetch = globalThis.fetch;
  function stub(status: number, body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("throws the caller's Error subclass with the envelope message on non-2xx", async () => {
    stub(403, { error: { message: "Not permitted." } });
    await expect(
      apiRequest(
        "/api/tenants/tnt_1/credentials",
        (data) => data as unknown,
        "loading credentials",
        FakeApiError,
      ),
    ).rejects.toMatchObject({ message: "Not permitted.", status: 403 });
    globalThis.fetch = realFetch;
  });

  test("never includes the raw path in a fallback message", async () => {
    stub(401, undefined);
    try {
      await apiRequest(
        "/api/tenants/tnt_1/credentials",
        (data) => data as unknown,
        "loading credentials",
        FakeApiError,
      );
      throw new Error("expected apiRequest to reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(FakeApiError);
      expect((cause as Error).message).not.toContain("/api/");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
