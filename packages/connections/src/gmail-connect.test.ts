// Unit tests for the Gmail connector's code-for-token exchange, driven
// entirely against a stubbed fetch — no Google credentials involved.
// Live-key verification against a real Google OAuth app is a deploy
// concern (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`), not a test one.
import { expect, test } from "bun:test";

import {
  exchangeCodeForGoogleToken,
  GOOGLE_TOKEN_EXCHANGE_URL,
} from "./gmail-connect";

function stubFetch(
  status: number,
  body: unknown,
  captured: { url?: string; body?: string },
) {
  return async (url: string, init: { body: string }) => {
    captured.url = url;
    captured.body = init.body;
    return new Response(JSON.stringify(body), { status });
  };
}

test("exchanges the code for an access token, expiry, and refresh token", async () => {
  const captured: { url?: string; body?: string } = {};
  const before = Date.now();
  const result = await exchangeCodeForGoogleToken({
    code: "auth-code-1",
    codeVerifier: "verifier-1",
    redirectUri: "https://bench.example.com/callback",
    clientId: "client-1",
    clientSecret: "secret-1",
    fetchImpl: stubFetch(
      200,
      {
        access_token: "ya29.token",
        expires_in: 3600,
        refresh_token: "1//refresh",
      },
      captured,
    ),
  });

  expect(captured.url).toBe(GOOGLE_TOKEN_EXCHANGE_URL);
  const params = new URLSearchParams(captured.body ?? "");
  expect(params.get("code")).toBe("auth-code-1");
  expect(params.get("client_id")).toBe("client-1");
  expect(params.get("client_secret")).toBe("secret-1");
  expect(params.get("redirect_uri")).toBe("https://bench.example.com/callback");
  expect(params.get("grant_type")).toBe("authorization_code");
  expect(params.get("code_verifier")).toBe("verifier-1");

  if (!result.ok) throw new Error(result.message);
  expect(result.apiKey).toBe("ya29.token");
  expect(result.refreshToken).toBe("1//refresh");
  const expiresAtMs = new Date(result.expiresAt ?? "").getTime();
  expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
});

test("a token response without a refresh token stores neither refresh nor a coerced empty value", async () => {
  const captured: { url?: string; body?: string } = {};
  const result = await exchangeCodeForGoogleToken({
    code: "auth-code-1",
    redirectUri: "https://bench.example.com/callback",
    clientId: "client-1",
    clientSecret: "secret-1",
    fetchImpl: stubFetch(200, { access_token: "ya29.token" }, captured),
  });
  if (!result.ok) throw new Error(result.message);
  expect(result.refreshToken).toBeUndefined();
  expect(result.expiresAt).toBeUndefined();
});

test("a Google error response maps to an honest failure that never echoes token material", async () => {
  const captured: { url?: string; body?: string } = {};
  const result = await exchangeCodeForGoogleToken({
    code: "expired-code",
    redirectUri: "https://bench.example.com/callback",
    clientId: "client-1",
    clientSecret: "secret-1",
    fetchImpl: stubFetch(
      400,
      { error: "invalid_grant", error_description: "Code was already used." },
      captured,
    ),
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.message).toContain("invalid_grant");
  expect(result.message).not.toContain("secret-1");
});
