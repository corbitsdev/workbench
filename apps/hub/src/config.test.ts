import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getConfig, loadConfig } from "./config";

const REQUIRED_ENV: Record<string, string> = {
  PORT: "3000",
  SIDECAR_TOKEN: "sidecar-secret",
  BETTER_AUTH_SECRET: "auth-secret",
  BETTER_AUTH_BASE_URL: "https://auth.example.com",
  DATABASE_URL: "postgres://localhost:5433/db",
  HUB_DATA_DIR: "/data",
  HUB_SIGNING_KEYS: "key1,key2",
  GLOBAL_TENANT_SLUG: "acme",
  GLOBAL_TENANT_NAME: "Acme",
  GLOBAL_TENANT_DOMAIN: "acme.example.com",
};

const MANAGED_KEYS = [
  ...Object.keys(REQUIRED_ENV),
  "NODE_ENV",
  "SUPPORTED_CORS_ORIGINS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_ALLOWED_DOMAINS",
  "WORKFLOW_AUTOPUBLISH_ON_BOOT",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setRequiredEnv(): void {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
}

describe("loadConfig", () => {
  it("parses a complete valid dev environment", () => {
    setRequiredEnv();
    process.env["SUPPORTED_CORS_ORIGINS"] = "https://a.com, https://b.com";

    const config = loadConfig();

    expect(config.isDev).toBe(true);
    expect(config.port).toBe("3000");
    expect(config.sidecarToken).toBe("sidecar-secret");
    expect(config.auth.secret).toBe("auth-secret");
    expect(config.auth.baseUrl).toBe("https://auth.example.com");
    expect(config.databaseUrl).toBe("postgres://localhost:5433/db");
    expect(config.hub.dataDir).toBe("/data");
    expect(config.hub.signingKeys).toBe("key1,key2");
    expect(config.globalTenant).toEqual({
      slug: "acme",
      name: "Acme",
      domain: "acme.example.com",
    });
    expect(config.granola.baseUrl).toBe("https://public-api.granola.ai/v1");
  });

  it("defaults workflowAutopublishOnBoot to false and enables it only for true/1", () => {
    setRequiredEnv();
    expect(loadConfig().workflowAutopublishOnBoot).toBe(false);

    process.env["WORKFLOW_AUTOPUBLISH_ON_BOOT"] = "true";
    expect(loadConfig().workflowAutopublishOnBoot).toBe(true);

    process.env["WORKFLOW_AUTOPUBLISH_ON_BOOT"] = "1";
    expect(loadConfig().workflowAutopublishOnBoot).toBe(true);

    process.env["WORKFLOW_AUTOPUBLISH_ON_BOOT"] = "false";
    expect(loadConfig().workflowAutopublishOnBoot).toBe(false);
  });

  it("trims and splits CORS origins, marking cross-origin true", () => {
    setRequiredEnv();
    process.env["SUPPORTED_CORS_ORIGINS"] = " https://a.com , ,https://b.com ";

    const config = loadConfig();

    expect(config.cors.origins).toEqual(["https://a.com", "https://b.com"]);
    expect(config.cors.isCrossOrigin).toBe(true);
  });

  it("marks auth as served from the web app when BETTER_AUTH_BASE_URL matches a CORS origin", () => {
    setRequiredEnv();
    process.env["NODE_ENV"] = "production";
    process.env["BETTER_AUTH_BASE_URL"] = "https://app.example.com";
    process.env["SUPPORTED_CORS_ORIGINS"] = "https://app.example.com";

    const config = loadConfig();

    expect(config.auth.servedFromWebApp).toBe(true);
    expect(config.auth.useCrossSiteCookies).toBe(false);
  });

  it("uses cross-site auth cookies when web and auth base URLs differ", () => {
    setRequiredEnv();
    process.env["NODE_ENV"] = "production";
    process.env["BETTER_AUTH_BASE_URL"] = "https://hub.example.com";
    process.env["SUPPORTED_CORS_ORIGINS"] = "https://app.example.com";

    const config = loadConfig();

    expect(config.auth.servedFromWebApp).toBe(false);
    expect(config.auth.useCrossSiteCookies).toBe(true);
  });



  it("treats empty CORS origins as same-origin in dev", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.cors.origins).toEqual([]);
    expect(config.cors.isCrossOrigin).toBe(false);
  });

  it("sets isDev false when NODE_ENV is production", () => {
    setRequiredEnv();
    process.env["NODE_ENV"] = "production";
    process.env["SUPPORTED_CORS_ORIGINS"] = "https://prod.com";

    const config = loadConfig();

    expect(config.isDev).toBe(false);
  });

  it("throws in production when CORS origins are missing", () => {
    setRequiredEnv();
    process.env["NODE_ENV"] = "production";

    expect(() => loadConfig()).toThrow(
      /SUPPORTED_CORS_ORIGINS must be set in production/,
    );
  });

  it("throws when GOOGLE_CLIENT_ID is set without GOOGLE_CLIENT_SECRET", () => {
    setRequiredEnv();
    process.env["GOOGLE_CLIENT_ID"] = "client-id";

    expect(() => loadConfig()).toThrow(/GOOGLE_CLIENT_SECRET is required/);
  });

  it("throws when GOOGLE_CLIENT_SECRET is set without GOOGLE_CLIENT_ID", () => {
    setRequiredEnv();
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";

    expect(() => loadConfig()).toThrow(/GOOGLE_CLIENT_ID is required/);
  });

  it("loads google config when both id and secret are present", () => {
    setRequiredEnv();
    process.env["GOOGLE_CLIENT_ID"] = "client-id";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["GOOGLE_ALLOWED_DOMAINS"] = "example.com, other.com";

    const config = loadConfig();

    expect(config.google.clientId).toBe("client-id");
    expect(config.google.clientSecret).toBe("client-secret");
    expect(config.google.allowedDomains).toEqual(["example.com", "other.com"]);
  });

  it("leaves google config undefined when neither id nor secret is set", () => {
    setRequiredEnv();

    const config = loadConfig();

    expect(config.google.clientId).toBeUndefined();
    expect(config.google.clientSecret).toBeUndefined();
    expect(config.google.allowedDomains).toEqual([]);
  });

  for (const key of Object.keys(REQUIRED_ENV)) {
    it(`throws when required env ${key} is missing`, () => {
      setRequiredEnv();
      process.env["SUPPORTED_CORS_ORIGINS"] = "https://a.com";
      delete process.env[key];

      expect(() => loadConfig()).toThrow(
        new RegExp(`Missing required environment variable: ${key}`),
      );
    });
  }
});

describe("getConfig", () => {
  it("returns the loaded config after loadConfig", () => {
    setRequiredEnv();
    const loaded = loadConfig();

    expect(getConfig()).toBe(loaded);
  });
});
