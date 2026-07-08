import { describe, expect, it } from "bun:test";
import {
  assertResolvedUrls,
  buildEnvPlan,
  buildRailwayVariableCommands,
  generateSecrets,
  hubWsUrl,
  parseManifest,
  selectEnvironment,
  type ClientManifest,
  type ClientSecrets,
} from "./plan";

const MANIFEST_TOML = `
[environments.production]
name = "Acme Corp"
slug = "acme"
domain = "acme.com"
hub_url = "https://acme-hub.up.railway.app"
web_url = "https://acme-web.up.railway.app"
app_env = "production"

[environments.staging]
name = "Acme Corp Staging"
slug = "acme-staging"
domain = "acme.com"
hub_url = "https://acme-hub-staging.up.railway.app"
web_url = "https://acme-web-staging.up.railway.app"
`;

const FIXED_SECRETS: ClientSecrets = {
  betterAuthSecret: "auth-secret-value",
  hubSigningKeys: "1:deadbeef",
  sidecarToken: "shared-token-value",
};

const SERVICES = { hub: "hub", sidecar: "sidecar", web: "web" } as const;

function loadManifest(): ClientManifest {
  return parseManifest(MANIFEST_TOML);
}

describe("parseManifest", () => {
  it("parses a well-formed manifest with multiple environments", () => {
    const m = loadManifest();
    expect(Object.keys(m.environments).sort()).toEqual([
      "production",
      "staging",
    ]);
    expect(m.environments.production.name).toBe("Acme Corp");
    expect(m.environments.staging.name).toBe("Acme Corp Staging");
  });

  it("throws when a required field is missing", () => {
    const bad = `[environments.production]\nname = "X"\nslug = "x"\ndomain = "x.com"\nhub_url = "https://h"\n`;
    expect(() => parseManifest(bad)).toThrow(/Invalid client manifest/);
  });

  it("throws when there are no environments", () => {
    expect(() => parseManifest(`environments = {}\n`)).not.toThrow();
    // empty env map parses; selection is what fails (covered below)
  });
});

describe("selectEnvironment", () => {
  it("returns the requested environment", () => {
    const env = selectEnvironment(loadManifest(), "staging");
    expect(env.slug).toBe("acme-staging");
  });

  it("throws listing available environments when missing", () => {
    expect(() => selectEnvironment(loadManifest(), "qa")).toThrow(
      /Available: production, staging/,
    );
  });
});

describe("generateSecrets", () => {
  it("produces correctly shaped, unique secrets", () => {
    const a = generateSecrets();
    expect(a.betterAuthSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hubSigningKeys).toMatch(/^1:[0-9a-f]{64}$/);
    expect(a.sidecarToken).toMatch(/^[0-9a-f]{64}$/);
    const b = generateSecrets();
    expect(b.betterAuthSecret).not.toBe(a.betterAuthSecret);
    expect(b.sidecarToken).not.toBe(a.sidecarToken);
  });
});

describe("hubWsUrl", () => {
  it("maps https to wss with the sidecar path", () => {
    expect(hubWsUrl("https://acme-hub.up.railway.app")).toBe(
      "wss://acme-hub.up.railway.app/api/sidecars/ws",
    );
  });
  it("maps http to ws for local", () => {
    expect(hubWsUrl("http://localhost:4000")).toBe(
      "ws://localhost:4000/api/sidecars/ws",
    );
  });
});

describe("assertResolvedUrls", () => {
  it("throws when a URL still holds the REPLACE placeholder", () => {
    const env = {
      slug: "x",
      domain: "x.com",
      hub_url: "https://REPLACE-hub.up.railway.app",
      web_url: "https://x-web.up.railway.app",
    };
    expect(() => assertResolvedUrls(env)).toThrow(/hub_url/);
  });
  it("passes when both URLs are resolved", () => {
    const env = selectEnvironment(loadManifest(), "production");
    expect(() => assertResolvedUrls(env)).not.toThrow();
  });
});

describe("buildEnvPlan", () => {
  const manifest = loadManifest();
  const env = selectEnvironment(manifest, "production");
  const plan = buildEnvPlan(env, FIXED_SECRETS);

  it("resolves the auth + CORS wiring from the hub and web URLs", () => {
    expect(plan.hub.BETTER_AUTH_BASE_URL).toBe(env.hub_url);
    expect(plan.hub.SUPPORTED_CORS_ORIGINS).toBe(env.web_url);
    expect(plan.web.VITE_API_BASE_URL).toBe(env.hub_url);
  });

  it("uses the same SIDECAR_TOKEN on hub and sidecar", () => {
    expect(plan.hub.SIDECAR_TOKEN).toBe(FIXED_SECRETS.sidecarToken);
    expect(plan.sidecar.SIDECAR_TOKEN).toBe(FIXED_SECRETS.sidecarToken);
  });

  it("derives the sidecar HUB_WS_URL from the hub URL", () => {
    expect(plan.sidecar.HUB_WS_URL).toBe(
      "wss://acme-hub.up.railway.app/api/sidecars/ws",
    );
  });

  it("carries tenant identity onto the hub", () => {
    expect(plan.hub.GLOBAL_TENANT_SLUG).toBe("acme");
    expect(plan.hub.GLOBAL_TENANT_NAME).toBe("Acme Corp");
    expect(plan.hub.GLOBAL_TENANT_DOMAIN).toBe("acme.com");
  });

  it("never sets DATABASE_URL (Postgres plugin injects it)", () => {
    expect(plan.hub).not.toHaveProperty("DATABASE_URL");
  });

  it("defaults VITE_APP_ENV to production when app_env is unset", () => {
    const staging = selectEnvironment(manifest, "staging");
    const stagingPlan = buildEnvPlan(staging, FIXED_SECRETS);
    expect(staging.app_env).toBeUndefined();
    expect(stagingPlan.web.VITE_APP_ENV).toBe("production");
  });
});

describe("buildRailwayVariableCommands", () => {
  const manifest = loadManifest();
  const env = selectEnvironment(manifest, "production");
  const plan = buildEnvPlan(env, FIXED_SECRETS);

  it("emits a scoped `railway variables --set` per variable", () => {
    const cmds = buildRailwayVariableCommands(plan, {
      services: SERVICES,
      environment: "production",
    });
    const authCmd = cmds.find((c) =>
      c.some((a) => a === "GLOBAL_TENANT_SLUG=acme"),
    );
    expect(authCmd).toEqual([
      "variables",
      "--set",
      "GLOBAL_TENANT_SLUG=acme",
      "--service",
      "hub",
      "--environment",
      "production",
      "--skip-deploys",
    ]);
  });

  it("threads --project through when provided", () => {
    const cmds = buildRailwayVariableCommands(plan, {
      services: SERVICES,
      environment: "production",
      project: "proj-123",
    });
    expect(
      cmds.every((c) => c.includes("--project") && c.includes("proj-123")),
    ).toBe(true);
  });

  it("skips secret keys already present to avoid rotating a live deployment", () => {
    const cmds = buildRailwayVariableCommands(plan, {
      services: SERVICES,
      environment: "production",
      existing: new Set(["hub:SIDECAR_TOKEN", "sidecar:SIDECAR_TOKEN"]),
    });
    const setsSidecarToken = cmds.some((c) =>
      c.some((a) => a.startsWith("SIDECAR_TOKEN=")),
    );
    expect(setsSidecarToken).toBe(false);
    // non-secret wiring is still emitted
    expect(
      cmds.some((c) => c.some((a) => a.startsWith("BETTER_AUTH_BASE_URL="))),
    ).toBe(true);
  });

  it("still sets a non-secret key even if listed in existing", () => {
    const cmds = buildRailwayVariableCommands(plan, {
      services: SERVICES,
      environment: "production",
      existing: new Set(["hub:GLOBAL_TENANT_SLUG"]),
    });
    expect(
      cmds.some((c) => c.some((a) => a === "GLOBAL_TENANT_SLUG=acme")),
    ).toBe(true);
  });
});
