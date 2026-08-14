// The exchange's own contract: parse OpenRouter's response at the trust
// boundary without ever putting key material in a failure message. PKCE
// and single-use state mechanics are shared with every connect flow and
// are tested once in `pkce.test.ts`.
import { describe, expect, test } from "bun:test";
import { exchangeCodeForKey, type ExchangeFetch } from "./openrouter-connect";

describe("exchangeCodeForKey", () => {
  test("posts code, verifier, and S256 to the exchange endpoint", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl: ExchangeFetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ key: "sk-or-v1-minted" }), {
        status: 200,
      });
    };

    const result = await exchangeCodeForKey({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, key: "sk-or-v1-minted" });
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(requests[0]?.body).toEqual({
      code: "auth_code_1",
      code_verifier: "verifier_1",
      code_challenge_method: "S256",
    });
  });

  test("a rejected exchange reports the status, never key material", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ error: "bad code" }), { status: 403 });

    const result = await exchangeCodeForKey({
      code: "expired",
      codeVerifier: "verifier_1",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      message: "OpenRouter rejected the code exchange with status 403",
    });
  });

  test("a 200 without a key is a failure, not a crash", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 });

    const result = await exchangeCodeForKey({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("did not carry a key");
  });

  test("a transport failure is reported honestly", async () => {
    const fetchImpl: ExchangeFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };

    const result = await exchangeCodeForKey({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ENOTFOUND");
  });
});
