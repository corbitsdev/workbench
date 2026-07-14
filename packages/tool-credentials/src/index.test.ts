import { describe, expect, test } from "bun:test";
import {
  TOOL_CREDENTIAL_ENV_PREFIX,
  ToolCredential,
  ToolCredentialMissingError,
  ToolCredentialsRequest,
  getToolCredential,
  providerFromEnvKey,
  toolCredentialEnvKey,
} from "./index";
import { type } from "arktype";

describe("tool-credential env keys", () => {
  test("builds and parses a provider-namespaced key", () => {
    const key = toolCredentialEnvKey("firecrawl");
    expect(key).toBe(`${TOOL_CREDENTIAL_ENV_PREFIX}firecrawl`);
    expect(providerFromEnvKey(key)).toBe("firecrawl");
  });

  test("providerFromEnvKey ignores unrelated keys and empty providers", () => {
    expect(providerFromEnvKey("mail.transport")).toBeUndefined();
    expect(providerFromEnvKey(TOOL_CREDENTIAL_ENV_PREFIX)).toBeUndefined();
  });
});

describe("getToolCredential", () => {
  test("returns the injected credential", () => {
    const env = {
      [toolCredentialEnvKey("exa")]: { apiKey: "k", baseURL: "https://api" },
    };
    expect(getToolCredential(env, "exa")).toEqual({
      apiKey: "k",
      baseURL: "https://api",
    });
  });

  test("throws ToolCredentialMissingError when the env key is entirely absent", () => {
    expect(() => getToolCredential({}, "exa")).toThrow(
      ToolCredentialMissingError,
    );
    try {
      getToolCredential({}, "exa");
      throw new Error("expected getToolCredential to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCredentialMissingError);
      expect((err as ToolCredentialMissingError).name).toBe(
        "ToolCredentialMissingError",
      );
      expect((err as ToolCredentialMissingError).providerName).toBe("exa");
    }
  });

  test("throws a generic Error when the key is present but malformed", () => {
    const env = { [toolCredentialEnvKey("exa")]: { apiKey: "k" } };
    try {
      getToolCredential(env, "exa");
      throw new Error("expected getToolCredential to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ToolCredentialMissingError);
      expect((err as Error).name).toBe("Error");
    }
  });
});

describe("wire schemas", () => {
  test("ToolCredentialsRequest validates the documented shape", () => {
    const ok = ToolCredentialsRequest({
      tenantId: "t",
      agentId: "a",
      providerNames: ["exa"],
    });
    expect(ok instanceof type.errors).toBe(false);
    const bad = ToolCredentialsRequest({ tenantId: "t", agentId: "a" });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("ToolCredential rejects a missing apiKey", () => {
    expect(ToolCredential({ baseURL: "x" }) instanceof type.errors).toBe(true);
  });
});
