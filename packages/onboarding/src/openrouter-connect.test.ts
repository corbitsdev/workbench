// The pure mechanics under the connect routes: the S256 challenge must
// match RFC 7636 exactly (OpenRouter recomputes it from the verifier we
// send back), the state store must give a verifier out exactly once and
// never across users or past its TTL, and the exchange must parse
// OpenRouter's response at the trust boundary without ever putting key
// material in a failure message.
import { describe, expect, test } from "bun:test";
import {
  createConnectStateStore,
  exchangeCodeForKey,
  generatePKCEPair,
  s256Challenge,
  type ExchangeFetch,
} from "./openrouter-connect";

describe("generatePKCEPair", () => {
  test("verifier and challenge are base64url with no padding", async () => {
    const pair = await generatePKCEPair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("challenge is the S256 of the verifier", async () => {
    const pair = await generatePKCEPair();
    expect(await s256Challenge(pair.codeVerifier)).toBe(pair.codeChallenge);
  });

  test("s256Challenge matches the RFC 7636 appendix vector", async () => {
    expect(
      await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("every pair is fresh", async () => {
    const first = await generatePKCEPair();
    const second = await generatePKCEPair();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("createConnectStateStore", () => {
  test("a state yields its verifier exactly once", () => {
    const store = createConnectStateStore();
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(store.consume({ state, userId: "user_1" })).toBe("v1");
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("a state issued for one user is worthless to another", () => {
    const store = createConnectStateStore();
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(store.consume({ state, userId: "user_2" })).toBeUndefined();
    // Consumed by the attempt: single-use means gone, not retryable.
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("an unknown state yields nothing", () => {
    const store = createConnectStateStore();
    expect(
      store.consume({ state: "never-issued", userId: "user_1" }),
    ).toBeUndefined();
  });

  test("an expired state yields nothing", () => {
    let clock = 0;
    const store = createConnectStateStore({ ttlMs: 1000, now: () => clock });
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    clock = 999;
    const fresh = store.issue({ userId: "user_1", codeVerifier: "v2" });
    clock = 1000;
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
    expect(store.consume({ state: fresh, userId: "user_1" })).toBe("v2");
  });
});

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
