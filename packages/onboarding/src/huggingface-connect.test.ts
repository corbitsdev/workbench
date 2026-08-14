// The pure mechanics under the Hugging Face connect routes: the
// exchange must post the standard authorization_code + PKCE form body
// to HF's token endpoint, parse its response at the trust boundary
// without ever putting token material in a failure message, and turn
// `expires_in` into the ISO instant `complete-credential.ts` stores as
// credential metadata. PKCE and single-use state mechanics themselves
// are covered once in `pkce.test.ts` (referenced from
// `openrouter-connect.test.ts`) and are not re-tested here.
import { describe, expect, test } from "bun:test";
import {
  exchangeCodeForToken,
  HUGGINGFACE_TOKEN_URL,
  type ExchangeFetch,
} from "./huggingface-connect";

describe("exchangeCodeForToken", () => {
  test("posts the standard authorization_code + PKCE form to HF's token endpoint", async () => {
    const requests: {
      url: string;
      body: string;
      headers: Record<string, string>;
    }[] = [];
    const fetchImpl: ExchangeFetch = async (url, init) => {
      requests.push({ url, body: init.body, headers: init.headers });
      return new Response(
        JSON.stringify({ access_token: "hf_oauth_minted", expires_in: 28800 }),
        { status: 200 },
      );
    };

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri:
        "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
      clientId: "client_1",
      fetchImpl,
      now: () => Date.parse("2026-08-13T12:00:00.000Z"),
    });

    expect(requests[0]?.url).toBe(HUGGINGFACE_TOKEN_URL);
    expect(requests[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(requests[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth_code_1");
    expect(body.get("code_verifier")).toBe("verifier_1");
    expect(body.get("client_id")).toBe("client_1");
    expect(body.get("redirect_uri")).toBe(
      "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
    );

    expect(result).toEqual({
      ok: true,
      accessToken: "hf_oauth_minted",
      expiresAt: "2026-08-13T20:00:00.000Z",
    });
  });

  test("a response with no expires_in still succeeds, with no expiresAt", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ access_token: "hf_oauth_minted" }), {
        status: 200,
      });

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri: "https://bench.example.com/cb",
      clientId: "client_1",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, accessToken: "hf_oauth_minted" });
  });

  test("a rejected exchange reports the status, never token material", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    const result = await exchangeCodeForToken({
      code: "expired",
      codeVerifier: "verifier_1",
      redirectUri: "https://bench.example.com/cb",
      clientId: "client_1",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      message: "Hugging Face rejected the code exchange with status 400",
    });
  });

  test("a 200 without an access token is a failure, not a crash", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 });

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri: "https://bench.example.com/cb",
      clientId: "client_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("did not carry an access token");
  });

  test("a transport failure is reported honestly", async () => {
    const fetchImpl: ExchangeFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri: "https://bench.example.com/cb",
      clientId: "client_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ENOTFOUND");
  });

  test("no failure message ever contains the minted access token", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ access_token: "hf_oauth_super_secret" }), {
        status: 500,
      });

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri: "https://bench.example.com/cb",
      clientId: "client_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).not.toContain("hf_oauth_super_secret");
  });
});
