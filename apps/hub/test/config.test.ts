import { describe, expect, test } from "bun:test";
import { readHubConfig } from "../src/config.ts";

const validEnv = {
  DATABASE_URL: "postgres://workbench:workbench@localhost:5432/workbench",
  BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "insecure-dev-only-session-secret-0000",
  HUB_DATA_DIR: ".data/hub",
  HUB_STATIC_DIR: "apps/hub/public",
};

function readExpectingError(env: Record<string, string | undefined>): string {
  try {
    readHubConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected readHubConfig to throw");
}

describe("readHubConfig", () => {
  test("returns typed config for a valid environment", () => {
    const config = readHubConfig(validEnv);
    expect(config).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      baseUrl: validEnv.BASE_URL,
      sessionSecret: validEnv.SESSION_SECRET,
      hubDataDir: validEnv.HUB_DATA_DIR,
      hubStaticDir: validEnv.HUB_STATIC_DIR,
      socialProviders: {},
      signupRateLimit: { windowSeconds: 60, max: 5 },
    });
  });

  describe("social providers", () => {
    test("absent by default", () => {
      expect(readHubConfig(validEnv).socialProviders).toEqual({});
    });

    test("a full Google pair enables google", () => {
      const config = readHubConfig({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
      });
      expect(config.socialProviders).toEqual({
        google: { clientId: "google-id", clientSecret: "google-secret" },
      });
    });

    test("a full GitHub pair enables github, independently of google", () => {
      const config = readHubConfig({
        ...validEnv,
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(config.socialProviders).toEqual({
        github: { clientId: "github-id", clientSecret: "github-secret" },
      });
    });

    test("both providers can be configured together", () => {
      const config = readHubConfig({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(Object.keys(config.socialProviders).sort()).toEqual([
        "github",
        "google",
      ]);
    });

    test("a client id with no secret fails loudly at boot", () => {
      const message = readExpectingError({
        ...validEnv,
        GOOGLE_CLIENT_ID: "google-id",
      });
      expect(message).toContain("GOOGLE_CLIENT_ID");
      expect(message).toContain("GOOGLE_CLIENT_SECRET");
    });

    test("a client secret with no id fails loudly at boot", () => {
      const message = readExpectingError({
        ...validEnv,
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      expect(message).toContain("GITHUB_CLIENT_ID");
      expect(message).toContain("GITHUB_CLIENT_SECRET");
    });
  });

  test("OPERATOR_TENANT_ID is optional and absent by default", () => {
    expect(readHubConfig(validEnv).operatorTenantId).toBeUndefined();
    expect(
      readHubConfig({ ...validEnv, OPERATOR_TENANT_ID: "ten_operator" })
        .operatorTenantId,
    ).toBe("ten_operator");
  });

  test("the signup rate limit is configurable and defaults sanely", () => {
    const config = readHubConfig({
      ...validEnv,
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: "30",
      SIGNUP_RATE_LIMIT_MAX: "2",
    });
    expect(config.signupRateLimit).toEqual({ windowSeconds: 30, max: 2 });
  });

  test("the seed model is absent when ANTHROPIC_API_KEY is not set", () => {
    const config = readHubConfig(validEnv);
    expect(config.seedModel).toBeUndefined();
  });

  test("ANTHROPIC_API_KEY builds an anthropic seed model with defaults", () => {
    const config = readHubConfig({
      ...validEnv,
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(config.seedModel).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
    });
  });

  test("accepts postgresql:// and https:// URL forms", () => {
    const config = readHubConfig({
      ...validEnv,
      DATABASE_URL: "postgresql://workbench@localhost:5432/workbench",
      BASE_URL: "https://workbench.example.com",
    });
    expect(config.databaseUrl).toStartWith("postgresql://");
    expect(config.baseUrl).toStartWith("https://");
  });

  test("an empty environment reports every variable in one error", () => {
    const message = readExpectingError({});
    for (const name of [
      "DATABASE_URL",
      "BASE_URL",
      "SESSION_SECRET",
      "HUB_DATA_DIR",
      "HUB_STATIC_DIR",
    ]) {
      expect(message).toContain(name);
    }
  });

  test("a malformed value is rejected naming the variable and the shape", () => {
    const message = readExpectingError({
      ...validEnv,
      DATABASE_URL: "mysql://nope",
      SESSION_SECRET: "too-short",
    });
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("Postgres connection URL");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("HUB_DATA_DIR");
  });
});
