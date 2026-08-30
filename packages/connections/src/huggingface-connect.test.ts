// The exchange's own contract: parse Hugging Face's response at the trust
// boundary without ever putting token material in a failure message, and
// route a transport failure through reportError.
import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import {
  exchangeCodeForToken,
  type ExchangeFetch,
} from "./huggingface-connect";

describe("exchangeCodeForToken", () => {
  test("trades the code and verifier for an access token", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(
        JSON.stringify({ access_token: "hf_minted_token", expires_in: 3600 }),
        { status: 200 },
      );

    const result = await exchangeCodeForToken({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      redirectUri: "https://hub.example.test/callback",
      clientId: "client_1",
      fetchImpl,
      now: () => 0,
    });

    expect(result).toEqual({
      ok: true,
      accessToken: "hf_minted_token",
      expiresAt: new Date(3600 * 1000).toISOString(),
    });
  });

  test("a transport failure is reported, never token material", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
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
      expect(result.message).toContain("getaddrinfo ENOTFOUND");
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "exchange_code_for_huggingface_token",
    });
    report.mockRestore();
  });
});
