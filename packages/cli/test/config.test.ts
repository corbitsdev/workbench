import { describe, expect, test } from "bun:test";
import {
  MODEL_CREDENTIAL_VARIABLES,
  readSeedConfig,
  readSetupConfig,
} from "../src/config";
import { CliError } from "../src/errors";

const VALID_SHARED = {
  BASE_URL: "http://localhost:3000",
  WORKBENCH_ADMIN_EMAIL: "admin@example.com",
  WORKBENCH_ADMIN_PASSWORD: "password123",
};

const VALID_MODEL = {
  WORKBENCH_MODEL_PROVIDER: "anthropic",
  WORKBENCH_MODEL: "claude-sonnet-4-5",
  WORKBENCH_MODEL_BASE_URL: "https://api.anthropic.com/v1",
  WORKBENCH_MODEL_API_KEY: "sk-test",
};

describe("readSetupConfig", () => {
  test("reports every missing variable at once with a fix", () => {
    let caught: unknown;
    try {
      readSetupConfig({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.message).toContain("WORKBENCH_ADMIN_EMAIL");
    expect(error.message).toContain("WORKBENCH_ADMIN_PASSWORD");
    expect(error.fix).toContain(".env");
  });

  test("names the hub URL when neither WORKBENCH_HUB_URL nor BASE_URL is set", () => {
    expect(() =>
      readSetupConfig({
        WORKBENCH_ADMIN_EMAIL: "admin@example.com",
        WORKBENCH_ADMIN_PASSWORD: "password123",
      }),
    ).toThrow(/WORKBENCH_HUB_URL or BASE_URL/);
  });

  test("resolves defaults at the edge and prefers WORKBENCH_HUB_URL", () => {
    const config = readSetupConfig({
      ...VALID_SHARED,
      WORKBENCH_HUB_URL: "http://hub.internal:8080",
    });
    expect(config.hubUrl).toBe("http://hub.internal:8080");
    expect(config.orgName).toBe("Workbench");
    expect(config.orgSlug).toBe("workbench");
  });

  test("falls back to BASE_URL for the hub origin", () => {
    expect(readSetupConfig(VALID_SHARED).hubUrl).toBe("http://localhost:3000");
  });

  test("rejects a malformed bench slug", () => {
    expect(() =>
      readSetupConfig({ ...VALID_SHARED, WORKBENCH_ORG_SLUG: "Not A Slug" }),
    ).toThrow(CliError);
  });
});

describe("readSeedConfig", () => {
  test("names every missing model-credential variable at once", () => {
    let caught: unknown;
    try {
      readSeedConfig(VALID_SHARED);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.message).toContain("WORKBENCH_MODEL_PROVIDER");
    expect(error.message).toContain("WORKBENCH_MODEL ");
    expect(error.message).toContain("WORKBENCH_MODEL_BASE_URL");
    expect(error.message).toContain("WORKBENCH_MODEL_API_KEY");
  });

  test("assembles the model source", () => {
    const config = readSeedConfig({ ...VALID_SHARED, ...VALID_MODEL });
    expect(config.modelSource).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-test",
    });
  });

  test("the credential checklist setup prints matches the variables seed reads", () => {
    for (const entry of MODEL_CREDENTIAL_VARIABLES) {
      const name = entry.split(" ")[0] ?? "";
      expect(Object.keys(VALID_MODEL)).toContain(name);
    }
  });
});
