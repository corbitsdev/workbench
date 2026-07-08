import { describe, expect, it } from "bun:test";
import {
  assertResolvedUrls,
  buildEnvPlan,
  buildRailwayVariableCommands,
  generateSecrets,
  hubWsUrl,
  parseManifest,
  selectEnvironment,
  type ClientEnvironment,
  type ClientManifest,
  type ClientSecrets,
} from "./plan";

// production: web served from a separate origin (web_url present, e.g. Vercel).
// staging: hub serves the SPA itself (no web_url).
const MANIFEST_TOML = `
[environments.production]
name = "Acme Corp"
slug = "acme"
domain = "acme.com"
hub_url = "https://acme-hub.up.railway.app"
web_url = "https://acme-web.vercel.app"

[environments.staging]
name = "Acme Corp Staging"
slug = "acme-staging"
domain = "acme.com"
hub_url = "https://acme-hub-staging.up.railway.app"
`;

const FIXED_SECRETS: ClientSecrets = {
  betterAuthSecret: "auth-secret-value",
  hubSigningKeys: "1:deadbeef",
  sidecarToken: "shared-token-value",
};

const SERVICES = { hub: "hub", sidecar: "sidecar" } as const;

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
    expect(m.environments.production.web_url).toBe(
      "https://acme-web.vercel.app",
    );
    expect(m.environments.staging.web_url).toBeUndefined();
  });

  it("throws when a required field is missing", () => {
    const bad = `[environments.production]\nname = "X"\nslug = "x"\ndomain = "x.com"\n`;
    expect(() => parseManifest(bad)).toThrow(/Invalid client manifest/);
  });

  it("accepts an environment with no web_url (hub-serves-web)", () => {
    expect(() => loadManifest()).not.toThrow();
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
  it("throws when the hub URL still holds the REPLACE placeholder", () => {
    const env: ClientEnvironment = {
      name: "X",
      slug: "x",
      domain: "x.com",
      hub_url: "https://REPLACE-hub.up.railway.app",
      web_url: "https://x-web.vercel.app",
    };
    expect(() => assertResolvedUrls(env)).toThrow(/hub_url/);
  });

  it("throws when a present web URL is still a placeholder", () => {
    const env: ClientEnvironment = {
      name: "X",
      slug: "x",
      domain: "x.com",
      hub_url: "https://x-hub.up.railway.app",
      web_url: "https://REPLACE-web.vercel.app",
    };
    expect(() => assertResolvedUrls(env)).toThrow(/web_url/);
  });

  it("passes with a resolved hub URL and no web URL", () => {
    const env = selectEnvironment(loadManifest(), "staging");
    expect(env.web_url).toBeUndefined();
    expect(() => assertResolvedUrls(env)).not.toThrow();
  });
});

describe("buildEnvPlan", () => {
  const manifest = loadManifest();

  it("uses the separate web URL as the auth + CORS origin when present", () => {
    const env = selectEnvironment(manifest, "production");
    const plan = buildEnvPlan(env, FIXED_SECRETS);
    expect(plan.hub.BETTER_AUTH_BASE_URL).toBe("https://acme-web.vercel.app");
    expect(plan.hub.SUPPORTED_CORS_ORIGINS).toBe("https://acme-web.vercel.app");
  });

  it("uses the hub URL as the origin when there is no separate web (hub-serves-web)", () => {
    const env = selectEnvironment(manifest, "staging");
    const plan = buildEnvPlan(env, FIXED_SECRETS);
    expect(plan.hub.BETTER_AUTH_BASE_URL).toBe(env.hub_url);
    expect(plan.hub.SUPPORTED_CORS_ORIGINS).toBe(env.hub_url);
  });

  it("points the sidecar HUB_WS_URL at the hub, never the web origin", () => {
    const env = selectEnvironment(manifest, "production");
    const plan = buildEnvPlan(env, FIXED_SECRETS);
    expect(plan.sidecar.HUB_WS_URL).toBe(
      "wss://acme-hub.up.railway.app/api/sidecars/ws",
    );
  });

  it("uses the same SIDECAR_TOKEN on hub and sidecar", () => {
    const plan = buildEnvPlan(
      selectEnvironment(manifest, "production"),
      FIXED_SECRETS,
    );
    expect(plan.hub.SIDECAR_TOKEN).toBe(FIXED_SECRETS.sidecarToken);
    expect(plan.sidecar.SIDECAR_TOKEN).toBe(FIXED_SECRETS.sidecarToken);
  });

  it("carries tenant identity onto the hub", () => {
    const plan = buildEnvPlan(
      selectEnvironment(manifest, "production"),
      FIXED_SECRETS,
    );
    expect(plan.hub.GLOBAL_TENANT_SLUG).toBe("acme");
    expect(plan.hub.GLOBAL_TENANT_NAME).toBe("Acme Corp");
    expect(plan.hub.GLOBAL_TENANT_DOMAIN).toBe("acme.com");
  });

  it("never sets DATABASE_URL and never emits a VITE var or a web service", () => {
    const plan = buildEnvPlan(
      selectEnvironment(manifest, "production"),
      FIXED_SECRETS,
    );
    expect(plan.hub).not.toHaveProperty("DATABASE_URL");
    expect(plan).not.toHaveProperty("web");
    const allKeys = [...Object.keys(plan.hub), ...Object.keys(plan.sidecar)];
    expect(allKeys.some((k) => k.startsWith("VITE_"))).toBe(false);
  });
});

describe("buildRailwayVariableCommands", () => {
  const manifest = loadManifest();
  const plan = buildEnvPlan(
    selectEnvironment(manifest, "production"),
    FIXED_SECRETS,
  );

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

  it("only targets the hub and sidecar services (never web)", () => {
    const cmds = buildRailwayVariableCommands(plan, {
      services: SERVICES,
      environment: "production",
    });
    const targetedServices = new Set(
      cmds.map((c) => c[c.indexOf("--service") + 1]),
    );
    expect([...targetedServices].sort()).toEqual(["hub", "sidecar"]);
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
