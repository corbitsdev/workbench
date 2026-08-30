// Unit tests for the Hugging Face connector's code-for-token exchange,
// driven entirely against a stubbed fetch -- no Hugging Face credentials
// involved.
import { expect, test } from "bun:test";

import {
  exchangeCodeForToken,
  HUGGINGFACE_TOKEN_URL,
  type ExchangeFetch,
} from "./huggingface-connect";

test("exchanges the code and verifier for an access token and expiry", async () => {
  const requests: { url: string; body: string }[] = [];
  const fetchImpl: ExchangeFetch = async (url, init) => {
    requests.push({ url, body: init.body });
    return new Response(
      JSON.stringify({ access_token: "hf_minted_token", expires_in: 3600 }),
      { status: 200 },
    );
  };

  const result = await exchangeCodeForToken({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    redirectUri: "https://hub.example.test/callback",
    clientId: "client_1",
    fetchImpl,
    now: () => 1_000_000,
  });

  expect(result).toEqual({
    ok: true,
    accessToken: "hf_minted_token",
    expiresAt: new Date(1_000_000 + 3600 * 1000).toISOString(),
  });
  expect(requests[0]?.url).toBe(HUGGINGFACE_TOKEN_URL);
  const params = new URLSearchParams(requests[0]?.body ?? "");
  expect(params.get("code")).toBe("auth_code_1");
  expect(params.get("code_verifier")).toBe("verifier_1");
});

test("a transport failure is reported honestly, never as a token", async () => {
  const fetchImpl: ExchangeFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const result = await exchangeCodeForToken({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    redirectUri: "https://hub.example.test/callback",
    clientId: "client_1",
    fetchImpl,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("Could not reach Hugging Face");
  }
});

// CL-7235: a Hugging Face token endpoint that never answers used to
// leave this exchange awaiting `doFetch` forever. It now carries a
// bounded `AbortSignal`, so a stalled provider is caught the same way
// any other network failure already is instead of hanging the
// `/callback` request indefinitely.
test("wires a bounded AbortSignal into the exchange fetch so a stalled provider can't hang the exchange", async () => {
  let capturedSignal: AbortSignal | undefined;
  const fetchImpl: ExchangeFetch = (_url, init) => {
    capturedSignal = init.signal;
    return new Promise(() => {
      // never resolves -- a provider that never answers.
    });
  };

  void exchangeCodeForToken({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    redirectUri: "https://hub.example.test/callback",
    clientId: "client_1",
    fetchImpl,
  });
  await Promise.resolve();

  expect(capturedSignal).toBeInstanceOf(AbortSignal);
  expect(capturedSignal?.aborted).toBe(false);
});
