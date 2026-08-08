// Real inference-shaped calls, fake network: these tests exercise
// `testAnthropicCredential` against a stub `fetch` that plays the two
// outcomes an onboarding user actually hits — a key Anthropic accepts,
// and one it rejects with 401 — plus a transport failure. The request
// itself is built by `@intx/inference`'s real Anthropic adapter, so
// what's under test is workbench's wiring of that adapter to a fetch
// call, not the wire format (that's Interchange's to test).
import { describe, expect, test } from "bun:test";
import {
  testAnthropicCredential,
  type FetchLike,
} from "../src/credential-test";

describe("testAnthropicCredential", () => {
  test("reports ok when the key is accepted", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ type: "message", content: [] }), {
        status: 200,
      });

    const result = await testAnthropicCredential({
      apiKey: "sk-ant-real-key",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
  });

  test("reports the specific reason when Anthropic rejects the key", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401 },
      );

    const result = await testAnthropicCredential({
      apiKey: "sk-ant-wrong",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("invalid x-api-key");
    }
  });

  test("reports a transport failure without pretending the key is bad", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    };

    const result = await testAnthropicCredential({
      apiKey: "sk-ant-real-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ENOTFOUND");
    }
  });

  test("sends the real API key, never the adapter's sentinel", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ type: "message" }), {
        status: 200,
      });
    };

    await testAnthropicCredential({ apiKey: "sk-ant-secret", fetchImpl });

    expect(seenHeaders["x-api-key"]).toBe("sk-ant-secret");
  });
});
