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
  "WORKFLOW_AUTOPUBLISH_MAP",
  "TOOL_REGISTRY_AUTOPUBLISH_ON_BOOT",
  "TOOL_REGISTRY_NAME",
  "WEDGE_SWEEP_INTERVAL_MS",
  "WEDGE_UNROUTABLE_GRACE_MS",
  "AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS",
  "RUN_LIVENESS_STALL_GRACE_MS",
  "RUN_LIVENESS_START_HARD_DEADLINE_MS",
  "RUN_LIVENESS_INTERVAL_MS",
  "IDLE_SESSION_REAP_AFTER_MS",
  "IDLE_SESSION_REAP_INTERVAL_MS",
  "HUB_AGENT_GC_PACK_THRESHOLD",
  "HUB_AGENT_GC_LOOSE_THRESHOLD",
  "HUB_AGENT_GC_WARN_BYTES",
  "AUTO_JOIN_TENANT_SLUGS",
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
    expect(config.autoJoinTenantSlugs).toEqual([]);
  });

  it("parses AUTO_JOIN_TENANT_SLUGS as a deduped slug list", () => {
    setRequiredEnv();
    process.env["AUTO_JOIN_TENANT_SLUGS"] = " abklabs, gtm ,abklabs,";
    expect(loadConfig().autoJoinTenantSlugs).toEqual(["abklabs", "gtm"]);
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

  it("defaults tool registry autopublish off and registry name to workbench-builtins", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.toolRegistryAutopublishOnBoot).toBe(false);
    expect(config.toolRegistryName).toBe("workbench-builtins");

    process.env["TOOL_REGISTRY_AUTOPUBLISH_ON_BOOT"] = "true";
    expect(loadConfig().toolRegistryAutopublishOnBoot).toBe(true);

    process.env["TOOL_REGISTRY_NAME"] = "custom-registry";
    expect(loadConfig().toolRegistryName).toBe("custom-registry");
  });

  it("defaults workflowAutopublishMap to null when unset or empty", () => {
    setRequiredEnv();
    expect(loadConfig().workflowAutopublishMap).toBeNull();

    process.env["WORKFLOW_AUTOPUBLISH_MAP"] = "   ";
    expect(loadConfig().workflowAutopublishMap).toBeNull();
  });

  it("parses a valid WORKFLOW_AUTOPUBLISH_MAP with kind and default keys", () => {
    setRequiredEnv();
    process.env["WORKFLOW_AUTOPUBLISH_MAP"] = JSON.stringify({
      "last30days-research": ["abk-labs"],
      default: ["acme"],
    });

    expect(loadConfig().workflowAutopublishMap).toEqual({
      "last30days-research": ["abk-labs"],
      default: ["acme"],
    });
  });

  it("throws when WORKFLOW_AUTOPUBLISH_MAP is malformed JSON", () => {
    setRequiredEnv();
    process.env["WORKFLOW_AUTOPUBLISH_MAP"] = "{not json";

    expect(() => loadConfig()).toThrow(
      /WORKFLOW_AUTOPUBLISH_MAP must be valid JSON/,
    );
  });

  it("throws when WORKFLOW_AUTOPUBLISH_MAP has the wrong shape", () => {
    setRequiredEnv();
    process.env["WORKFLOW_AUTOPUBLISH_MAP"] = JSON.stringify({
      "last30days-research": "abk-labs",
    });

    expect(() => loadConfig()).toThrow(
      /WORKFLOW_AUTOPUBLISH_MAP has an invalid shape/,
    );
  });

  it("defaults wedgeSweepIntervalMs to 30000 and honors a positive override", () => {
    setRequiredEnv();
    expect(loadConfig().wedgeSweepIntervalMs).toBe(30_000);

    process.env["WEDGE_SWEEP_INTERVAL_MS"] = "5000";
    expect(loadConfig().wedgeSweepIntervalMs).toBe(5_000);
  });

  it("defaults awaitingSupervisorPrewarmIntervalMs to 30000 and honors a positive override", () => {
    setRequiredEnv();
    expect(loadConfig().awaitingSupervisorPrewarmIntervalMs).toBe(30_000);

    process.env["AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS"] = "10000";
    expect(loadConfig().awaitingSupervisorPrewarmIntervalMs).toBe(10_000);
  });

  it("rejects a zero, negative, decimal, or non-numeric AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS", () => {
    setRequiredEnv();
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      process.env["AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS"] = bad;
      expect(() => loadConfig()).toThrow(
        `AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS must be a positive integer (milliseconds); got "${bad}"`,
      );
    }
  });

  it("rejects a zero, negative, decimal, or non-numeric WEDGE_SWEEP_INTERVAL_MS", () => {
    setRequiredEnv();
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      process.env["WEDGE_SWEEP_INTERVAL_MS"] = bad;
      expect(() => loadConfig()).toThrow(
        `WEDGE_SWEEP_INTERVAL_MS must be a positive integer (milliseconds); got "${bad}"`,
      );
    }
  });

  it("defaults wedgeUnroutableGraceMs to 120000 and honors a positive override", () => {
    setRequiredEnv();
    expect(loadConfig().wedgeUnroutableGraceMs).toBe(120_000);

    process.env["WEDGE_UNROUTABLE_GRACE_MS"] = "90000";
    expect(loadConfig().wedgeUnroutableGraceMs).toBe(90_000);
  });

  it("rejects a zero, negative, decimal, or non-numeric WEDGE_UNROUTABLE_GRACE_MS", () => {
    setRequiredEnv();
    for (const bad of ["0", "-1", "2.5", "nope"]) {
      process.env["WEDGE_UNROUTABLE_GRACE_MS"] = bad;
      expect(() => loadConfig()).toThrow(
        `WEDGE_UNROUTABLE_GRACE_MS must be a positive integer (milliseconds); got "${bad}"`,
      );
    }
  });

  it("defaults the run liveness sweep knobs to generous values and honors overrides", () => {
    setRequiredEnv();
    const sweep = loadConfig().runLivenessSweep;
    expect(sweep.stallGraceMs).toBe(5 * 60 * 1000);
    expect(sweep.startHardDeadlineMs).toBe(20 * 60 * 1000);
    expect(sweep.intervalMs).toBe(60 * 1000);

    process.env["RUN_LIVENESS_STALL_GRACE_MS"] = "120000";
    process.env["RUN_LIVENESS_START_HARD_DEADLINE_MS"] = "600000";
    process.env["RUN_LIVENESS_INTERVAL_MS"] = "30000";
    const overridden = loadConfig().runLivenessSweep;
    expect(overridden.stallGraceMs).toBe(120_000);
    expect(overridden.startHardDeadlineMs).toBe(600_000);
    expect(overridden.intervalMs).toBe(30_000);
  });

  it("defaults the idle session reaper to a 5-minute threshold swept every minute and honors overrides", () => {
    setRequiredEnv();
    const reaper = loadConfig().idleSessionReaper;
    expect(reaper.reapAfterMs).toBe(5 * 60 * 1000);
    expect(reaper.intervalMs).toBe(60 * 1000);

    process.env["IDLE_SESSION_REAP_AFTER_MS"] = "1800000";
    process.env["IDLE_SESSION_REAP_INTERVAL_MS"] = "120000";
    const overridden = loadConfig().idleSessionReaper;
    expect(overridden.reapAfterMs).toBe(1_800_000);
    expect(overridden.intervalMs).toBe(120_000);
  });

  it("rejects a non-positive-integer idle session reaper knob", () => {
    for (const key of [
      "IDLE_SESSION_REAP_AFTER_MS",
      "IDLE_SESSION_REAP_INTERVAL_MS",
    ]) {
      for (const bad of ["0", "-5", "1.5", "abc"]) {
        setRequiredEnv();
        process.env[key] = bad;
        expect(() => loadConfig()).toThrow(
          `${key} must be a positive integer (milliseconds); got "${bad}"`,
        );
        delete process.env[key];
      }
    }
  });

  it("rejects a non-positive-integer run liveness sweep knob", () => {
    setRequiredEnv();
    for (const key of [
      "RUN_LIVENESS_STALL_GRACE_MS",
      "RUN_LIVENESS_START_HARD_DEADLINE_MS",
      "RUN_LIVENESS_INTERVAL_MS",
    ]) {
      for (const bad of ["0", "-5", "1.5", "abc"]) {
        setRequiredEnv();
        process.env[key] = bad;
        expect(() => loadConfig()).toThrow(
          `${key} must be a positive integer (milliseconds); got "${bad}"`,
        );
        delete process.env[key];
      }
    }
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

describe("hub agent GC config", () => {
  it("uses the upstream hub defaults when env is unset", () => {
    setRequiredEnv();
    expect(loadConfig().hub.agentGc).toEqual({
      packThreshold: 64,
      looseThreshold: 2048,
      warnBytes: 256 * 1024 * 1024,
    });
  });

  it("overrides thresholds from env", () => {
    setRequiredEnv();
    process.env["HUB_AGENT_GC_PACK_THRESHOLD"] = "8";
    process.env["HUB_AGENT_GC_LOOSE_THRESHOLD"] = "300";
    process.env["HUB_AGENT_GC_WARN_BYTES"] = "4096";
    expect(loadConfig().hub.agentGc).toEqual({
      packThreshold: 8,
      looseThreshold: 300,
      warnBytes: 4096,
    });
  });

  it("rejects a non-integer threshold", () => {
    setRequiredEnv();
    process.env["HUB_AGENT_GC_WARN_BYTES"] = "lots";
    expect(() => loadConfig()).toThrow(
      'HUB_AGENT_GC_WARN_BYTES must be a positive integer; got "lots"',
    );
  });
});
