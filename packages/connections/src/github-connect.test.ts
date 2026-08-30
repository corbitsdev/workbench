// The exchange's own contract: parse GitHub's response at the trust
// boundary without ever putting token material in a failure message, and
// surface GitHub's own `error`/`error_description` shape (distinct from
// a non-2xx status — GitHub's token endpoint answers 200 with an `error`
// field on a rejected code).
import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import {
  exchangeCodeForGithubToken,
  type ExchangeFetch,
} from "./github-connect";

describe("exchangeCodeForGithubToken", () => {
  test("posts code, client id/secret, and redirect uri to the exchange endpoint", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl: ExchangeFetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ access_token: "gho_minted_token" }),
        { status: 200 },
      );
    };

    const result = await exchangeCodeForGithubToken({
      code: "auth_code_1",
      redirectUri: "https://hub.example.test/api/tenants/oauth/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, key: "gho_minted_token" });
    expect(requests[0]?.url).toBe(
      "https://github.com/login/oauth/access_token",
    );
    expect(requests[0]?.body).toEqual({
      client_id: "client_1",
      client_secret: "secret_1",
      code: "auth_code_1",
      redirect_uri: "https://hub.example.test/api/tenants/oauth/callback",
    });
  });

  test("a 200 carrying GitHub's own error shape is a failure, not a crash", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(
        JSON.stringify({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
        { status: 200 },
      );

    const result = await exchangeCodeForGithubToken({
      code: "expired",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      message: "The code passed is incorrect or expired.",
    });
  });

  test("a rejected exchange reports the status, never token material", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
      });

    const result = await exchangeCodeForGithubToken({
      code: "auth_code_1",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      message: "GitHub rejected the code exchange with status 500",
    });
  });

  test("a 200 without a token is a failure, not a crash", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 });

    const result = await exchangeCodeForGithubToken({
      code: "auth_code_1",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("did not carry a token");
  });

  test("a transport failure is reported honestly", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const fetchImpl: ExchangeFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };

    const result = await exchangeCodeForGithubToken({
      code: "auth_code_1",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Could not reach GitHub");
      expect(result.message).toContain("getaddrinfo ENOTFOUND");
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "exchange_code_for_github_token",
    });
    report.mockRestore();
  });

  // CL-7235: a GitHub token endpoint that never answers used to leave
  // this exchange awaiting `doFetch` forever. It now carries a bounded
  // `AbortSignal`, so a stalled provider is caught the same way any
  // other network failure already is instead of hanging the `/callback`
  // request indefinitely.
  test("wires a bounded AbortSignal into the exchange fetch so a stalled provider can't hang the exchange", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl: ExchangeFetch = (_url, init) => {
      capturedSignal = init.signal;
      return new Promise(() => {
        // never resolves -- a provider that never answers.
      });
    };

    void exchangeCodeForGithubToken({
      code: "auth_code_1",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      clientSecret: "secret_1",
      fetchImpl,
    });
    await Promise.resolve();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });
});
