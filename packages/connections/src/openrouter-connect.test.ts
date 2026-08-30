// Unit tests for the OpenRouter connector's code-for-key exchange,
// driven entirely against a stubbed fetch -- no OpenRouter credentials
// involved.
import { expect, test } from "bun:test";

import {
  exchangeCodeForKey,
  OPENROUTER_KEY_EXCHANGE_URL,
  type ExchangeFetch,
} from "./openrouter-connect";

test("exchanges the code and verifier for the user-scoped API key", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl: ExchangeFetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ key: "sk-or-minted" }), {
      status: 200,
    });
  };

  const result = await exchangeCodeForKey({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    fetchImpl,
  });

  expect(result).toEqual({ ok: true, key: "sk-or-minted" });
  expect(requests[0]?.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
  expect(requests[0]?.body).toEqual({
    code: "auth_code_1",
    code_verifier: "verifier_1",
    code_challenge_method: "S256",
  });
});

test("a transport failure is reported honestly, never as a key", async () => {
  const fetchImpl: ExchangeFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const result = await exchangeCodeForKey({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    fetchImpl,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("Could not reach OpenRouter");
  }
});

// CL-7235: an OpenRouter key endpoint that never answers used to leave
// this exchange awaiting `doFetch` forever. It now carries a bounded
// `AbortSignal`, so a stalled provider is caught the same way any other
// network failure already is instead of hanging the `/callback` request
// indefinitely.
test("wires a bounded AbortSignal into the exchange fetch so a stalled provider can't hang the exchange", async () => {
  let capturedSignal: AbortSignal | undefined;
  const fetchImpl: ExchangeFetch = (_url, init) => {
    capturedSignal = init.signal;
    return new Promise(() => {
      // never resolves -- a provider that never answers.
    });
  };

  void exchangeCodeForKey({
    code: "auth_code_1",
    codeVerifier: "verifier_1",
    fetchImpl,
  });
  await Promise.resolve();

  expect(capturedSignal).toBeInstanceOf(AbortSignal);
  expect(capturedSignal?.aborted).toBe(false);
});
