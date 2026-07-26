import { describe, expect, test } from "bun:test";
import type { OAuthProviderConfig } from "@workbench/shared";
import {
  accountIdFromIdToken,
  exchangeCodeForToken,
  refreshOAuthToken,
  summarizeTokenErrorBody,
  type OAuthClientConfig,
} from "./oauth-flow";

const PUBLIC_CLIENT: OAuthProviderConfig = {
  providerName: "chatgpt-codex",
  label: "ChatGPT / Codex",
  authorizationUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: ["openid", "offline_access"],
  scopeDescriptions: {},
  usePkce: true,
  hasRefresh: true,
  publicClientId: "app_public",
  clientSecretRequired: false,
};

const OWNER_APP_CLIENT: OAuthProviderConfig = {
  providerName: "linear",
  label: "Linear",
  authorizationUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  scopes: ["read"],
  scopeDescriptions: {},
  usePkce: false,
  hasRefresh: false,
  appCredentialProviderName: "linear-oauth-app",
  setup: {
    registerUrl: "https://linear.app/settings/api/applications/new",
    callbackPath: "/oauth/callback/linear",
    steps: ["step"],
    fieldHints: { clientId: "id", clientSecret: "secret" },
  },
};

function clientConfig(secret: string): OAuthClientConfig {
  return {
    clientId: "client-1",
    clientSecret: secret,
    redirectUri: "https://hub.test/oauth/callback/x",
  };
}

function capturingFetch(response: Response): {
  fetchImpl: typeof fetch;
  body: () => URLSearchParams;
} {
  let captured = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = String(init.body);
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, body: () => new URLSearchParams(captured) };
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
}

describe("public-client token requests", () => {
  test("clientSecretRequired: false omits client_secret from the code exchange", async () => {
    const { fetchImpl, body } = capturingFetch(tokenResponse());

    await exchangeCodeForToken({
      providerConfig: PUBLIC_CLIENT,
      clientConfig: clientConfig(""),
      code: "code-1",
      verifier: "verifier-1",
      fetchImpl,
    });

    const sent = body();
    expect(sent.has("client_secret")).toBe(false);
    expect(sent.get("client_id")).toBe("client-1");
    expect(sent.get("code_verifier")).toBe("verifier-1");
  });

  test("clientSecretRequired: false omits client_secret from the refresh", async () => {
    const { fetchImpl, body } = capturingFetch(tokenResponse());

    await refreshOAuthToken({
      providerConfig: PUBLIC_CLIENT,
      clientConfig: clientConfig(""),
      refreshToken: "rt-1",
      fetchImpl,
    });

    const sent = body();
    expect(sent.has("client_secret")).toBe(false);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("rt-1");
  });

  test("an owner-app provider still sends client_secret", async () => {
    const { fetchImpl, body } = capturingFetch(tokenResponse());

    await exchangeCodeForToken({
      providerConfig: OWNER_APP_CLIENT,
      clientConfig: clientConfig("owner-secret"),
      code: "code-1",
      verifier: null,
      fetchImpl,
    });

    expect(body().get("client_secret")).toBe("owner-secret");
  });
});

describe("summarizeTokenErrorBody", () => {
  test("reduces an RFC 6749 JSON body to error and description", () => {
    expect(
      summarizeTokenErrorBody(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token expired",
          request_id: "req-1",
        }),
      ),
    ).toBe("invalid_grant: Token expired");
  });

  test("redacts token-shaped strings so a logged failure cannot leak one", () => {
    const leak = "a".repeat(64);
    const summary = summarizeTokenErrorBody(`refresh token ${leak} rejected`);
    expect(summary).not.toContain(leak);
    expect(summary).toContain("[redacted]");
  });

  test("bounds an unbounded provider body", () => {
    const summary = summarizeTokenErrorBody("!".repeat(5000));
    expect(summary.length).toBeLessThanOrEqual(257);
  });
});

describe("accountIdFromIdToken", () => {
  function jwt(payload: unknown): string {
    return [
      "header",
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "sig",
    ].join(".");
  }

  test("extracts the account id from the OpenAI auth namespace claim", () => {
    expect(
      accountIdFromIdToken(
        jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
      ),
    ).toBe("acct-1");
  });

  test("returns null for a token that is not three dot-separated parts", () => {
    expect(accountIdFromIdToken("not-a-jwt")).toBeNull();
  });

  test("returns null when the payload segment is not valid JSON", () => {
    expect(accountIdFromIdToken("header.bm90LWpzb24.sig")).toBeNull();
  });

  test("returns null when no account-id claim is present", () => {
    expect(accountIdFromIdToken(jwt({ sub: "user-1" }))).toBeNull();
  });
});
