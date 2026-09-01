import { describe, expect, test } from "bun:test";
import {
  MODEL_CREDENTIAL_VARIABLES,
  readSeedConfig,
  readSetupConfig,
} from "../src/config";
import { CliError } from "@workbench/hub-client";

const VALID_SHARED = {
  BASE_URL: "http://localhost:3000",
  HUB_ADMIN_EMAIL: "admin@example.com",
  HUB_ADMIN_PASSWORD: "password123",
};

describe("readSetupConfig", () => {
  test("defaults the admin identity when the variables are unset", () => {
    const config = readSetupConfig({ BASE_URL: "http://localhost:3000" });
    expect(config.adminEmail).toBe("alice@example.com");
    expect(config.adminPassword).toBe("password123");
  });

  test("reports a malformed admin email with a fix", () => {
    let caught: unknown;
    try {
      readSetupConfig({
        BASE_URL: "http://localhost:3000",
        HUB_ADMIN_EMAIL: "not-an-email",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.message).toContain("HUB_ADMIN_EMAIL");
    expect(error.fix).toContain(".env");
  });

  test("names the hub URL when neither HUB_URL nor BASE_URL is set", () => {
    expect(() =>
      readSetupConfig({
        HUB_ADMIN_EMAIL: "admin@example.com",
        HUB_ADMIN_PASSWORD: "password123",
      }),
    ).toThrow(/HUB_URL or BASE_URL/);
  });

  test("resolves defaults at the edge and prefers HUB_URL", () => {
    const config = readSetupConfig({
      ...VALID_SHARED,
      HUB_URL: "http://hub.internal:8080",
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
      readSetupConfig({ ...VALID_SHARED, ORG_SLUG: "Not A Slug" }),
    ).toThrow(CliError);
  });

  test("ORG_SLUG sets the bench slug when WORKBENCH_DEFAULT_TENANT is unset", () => {
    expect(readSetupConfig({ ...VALID_SHARED, ORG_SLUG: "acme" }).orgSlug).toBe(
      "acme",
    );
  });

  test("WORKBENCH_DEFAULT_TENANT wins over ORG_SLUG for the bench slug", () => {
    expect(
      readSetupConfig({
        ...VALID_SHARED,
        WORKBENCH_DEFAULT_TENANT: "root",
        ORG_SLUG: "acme",
      }).orgSlug,
    ).toBe("root");
  });
});

describe("readSeedConfig", () => {
  test("ANTHROPIC_API_KEY is optional", () => {
    const config = readSeedConfig(VALID_SHARED);
    expect(config.anthropicApiKeyConfigured).toBe(false);
    expect(config.modelSource).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "placeholder-not-a-real-key",
    });
  });

  test("a configured ANTHROPIC_API_KEY is used as the model source's key", () => {
    const config = readSeedConfig({
      ...VALID_SHARED,
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(config.anthropicApiKeyConfigured).toBe(true);
    expect(config.modelSource).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
    });
  });

  test("the credential checklist setup prints names ANTHROPIC_API_KEY", () => {
    expect(MODEL_CREDENTIAL_VARIABLES.length).toBe(1);
    expect(MODEL_CREDENTIAL_VARIABLES[0]).toContain("ANTHROPIC_API_KEY");
  });

  test("the catalog-test workflow opt-in defaults off", () => {
    expect(readSeedConfig(VALID_SHARED).seedCatalogTestWorkflows).toBe(false);
  });

  test("WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS=1 opts into the catalog-test workflows", () => {
    const config = readSeedConfig({
      ...VALID_SHARED,
      WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS: "1",
    });
    expect(config.seedCatalogTestWorkflows).toBe(true);
  });

  test("any other value for WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS stays opted out", () => {
    const config = readSeedConfig({
      ...VALID_SHARED,
      WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS: "true",
    });
    expect(config.seedCatalogTestWorkflows).toBe(false);
  });
});
