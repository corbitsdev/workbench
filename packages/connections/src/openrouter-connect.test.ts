// The exchange's own contract: parse OpenRouter's response at the trust
// boundary without ever putting key material in a failure message, and
// route a transport failure through reportError.
import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import { exchangeCodeForKey, type ExchangeFetch } from "./openrouter-connect";

describe("exchangeCodeForKey", () => {
  test("trades the code and verifier for a durable key", async () => {
    const fetchImpl: ExchangeFetch = async () =>
      new Response(JSON.stringify({ key: "sk-or-minted-key" }), {
        status: 200,
      });

    const result = await exchangeCodeForKey({
      code: "auth_code_1",
      codeVerifier: "verifier_1",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, key: "sk-or-minted-key" });
  });

  test("a transport failure is reported, never key material", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
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
      expect(result.message).toContain("getaddrinfo ENOTFOUND");
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "exchange_code_for_openrouter_key",
    });
    report.mockRestore();
  });
});
