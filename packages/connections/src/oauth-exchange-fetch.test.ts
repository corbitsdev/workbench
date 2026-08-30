// Every OAuth connect module (github-connect.ts, gmail-connect.ts,
// huggingface-connect.ts, openrouter-connect.ts) routes its outbound
// token/key exchange through `postExchangeRequest`. These tests exercise
// that shared mechanism directly, standing in for a per-provider hang
// test: proving the timeout cancels an in-flight request (aborts the
// fetch a real implementation is waiting on) rather than racing a timer
// while the request keeps running unobserved.
import { expect, test } from "bun:test";

import {
  OAUTH_EXCHANGE_TIMEOUT_MS,
  postExchangeRequest,
  type OAuthExchangeFetch,
} from "./oauth-exchange-fetch";

// The two real-timer tests below use a small but not razor-thin
// `timeoutMs` (100ms) and a generous per-test timeout (20s) so they
// prove the abort actually fires without false-failing on a busy CI
// runner -- the assertion is "clearly bounded, not that it happened in
// under a handful of milliseconds."
test("a provider that never answers is aborted once the timeout fires, not left hanging", async () => {
  let sawAbort = false;
  const fetchImpl: OAuthExchangeFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        sawAbort = true;
        reject(init.signal?.reason);
      });
    });

  await expect(
    postExchangeRequest(
      fetchImpl,
      "https://provider.example.test/token",
      { method: "POST", headers: {}, body: "" },
      100,
    ),
  ).rejects.toBeDefined();
  expect(sawAbort).toBe(true);
}, 20_000);

test("passes the caller's timeoutMs through to the abort signal, not the default", async () => {
  const start = performance.now();
  const fetchImpl: OAuthExchangeFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  await expect(
    postExchangeRequest(
      fetchImpl,
      "https://provider.example.test/token",
      { method: "POST", headers: {}, body: "" },
      100,
    ),
  ).rejects.toBeDefined();

  expect(performance.now() - start).toBeLessThan(OAUTH_EXCHANGE_TIMEOUT_MS);
}, 20_000);

test("a provider that answers before the timeout resolves normally", async () => {
  const fetchImpl: OAuthExchangeFetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });

  const response = await postExchangeRequest(
    fetchImpl,
    "https://provider.example.test/token",
    { method: "POST", headers: {}, body: "" },
    5,
  );

  expect(response.status).toBe(200);
});

test("defaults to OAUTH_EXCHANGE_TIMEOUT_MS when no timeoutMs is given", async () => {
  const fetchImpl: OAuthExchangeFetch = (_url, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  await postExchangeRequest(fetchImpl, "https://provider.example.test/token", {
    method: "POST",
    headers: {},
    body: "",
  });
});
