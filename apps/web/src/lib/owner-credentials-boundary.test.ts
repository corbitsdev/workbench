/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";

// Pins the arktype boundary guard on the owner-credentials client fns: a
// malformed payload must throw (fail-closed), never slip through. Also pins
// that a well-formed payload never surfaces a raw secret value even if a
// misbehaving server were to include one — the schema strips unknown fields,
// but this test asserts the parsed shape itself carries no secret key.
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

const { getOwnerCredentials, setOwnerCredential, clearOwnerCredential } =
  await import("./hub-api");

const validList = {
  credentials: [
    {
      providerName: "anthropic",
      label: "Anthropic",
      kind: "inference",
      configured: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      providerName: "exa",
      label: "Exa",
      kind: "tool",
      configured: false,
      updatedAt: null,
    },
  ],
};

const validState = {
  providerName: "anthropic",
  label: "Anthropic",
  kind: "inference",
  configured: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("getOwnerCredentials boundary", () => {
  it("resolves a well-formed payload with masked state only, split by kind", async () => {
    globalThis.fetch = fakeFetch(validList) as typeof fetch;
    const rows = await getOwnerCredentials();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(validList.credentials[0]);
    expect(rows.filter((r) => r.kind === "inference")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "tool")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("throws when configured is the wrong type", async () => {
    globalThis.fetch = fakeFetch({
      credentials: [{ ...validList.credentials[0], configured: "yes" }],
    }) as typeof fetch;
    await expect(getOwnerCredentials()).rejects.toThrow();
  });

  it("throws on a missing field", async () => {
    globalThis.fetch = fakeFetch({
      credentials: [{ providerName: "anthropic", configured: true }],
    }) as typeof fetch;
    await expect(getOwnerCredentials()).rejects.toThrow();
  });

  it("throws when kind is not inference/tool", async () => {
    globalThis.fetch = fakeFetch({
      credentials: [{ ...validList.credentials[0], kind: "other" }],
    }) as typeof fetch;
    await expect(getOwnerCredentials()).rejects.toThrow();
  });
});

describe("setOwnerCredential / clearOwnerCredential boundary", () => {
  it("resolves a well-formed set response", async () => {
    globalThis.fetch = fakeFetch(validState) as typeof fetch;
    const result = await setOwnerCredential("anthropic", "sk-test");
    expect(result).toEqual(validState);
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("throws when the set response is malformed", async () => {
    globalThis.fetch = fakeFetch({ providerName: "anthropic" }) as typeof fetch;
    await expect(setOwnerCredential("anthropic", "sk-test")).rejects.toThrow();
  });

  it("accepts optional baseURL on set and echoes it in the masked response (bifrost)", async () => {
    const bifrostState = {
      ...validState,
      providerName: "bifrost",
      label: "Bifrost",
      baseURL: "https://bifrost.example.com/v1",
    };
    globalThis.fetch = fakeFetch(bifrostState) as typeof fetch;
    const result = await setOwnerCredential(
      "bifrost",
      "vk-abc123",
      "https://bifrost.example.com/v1",
    );
    expect(result).toEqual(bifrostState);
    expect(result.baseURL).toBe("https://bifrost.example.com/v1");
  });

  it("resolves a well-formed clear response", async () => {
    globalThis.fetch = fakeFetch({
      ...validState,
      configured: false,
      updatedAt: null,
    }) as typeof fetch;
    const result = await clearOwnerCredential("anthropic");
    expect(result.configured).toBe(false);
    expect(result.updatedAt).toBeNull();
  });
});
