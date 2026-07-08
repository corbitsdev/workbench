import { type } from "arktype";

// Pure config engine for client provisioning. Turns a non-secret client manifest
// (clients/<slug>.toml) plus a target environment into the complete, correct set
// of environment variables for each Railway service — resolving the wiring graph
// that is the standup footgun. No I/O, no Railway calls: those live in the CLI.
//
// Build/deploy config (Dockerfile, watchPatterns, preDeploy, healthcheck) is NOT
// produced here — it lives in the committed apps/*/railway.toml (Railway
// Config-as-Code). This engine only owns per-client, per-environment variables.

export const ClientEnvironmentSchema = type({
  name: "string > 0",
  slug: "string > 0",
  domain: "string > 0",
  hub_url: "string > 0",
  web_url: "string > 0",
  "app_env?": "string > 0",
});
export type ClientEnvironment = typeof ClientEnvironmentSchema.infer;

// Each environment fully specifies its own tenant identity (name/slug/domain) —
// staging and production are distinct orgs, not just distinct URLs.
export const ClientManifestSchema = type({
  environments: { "[string]": ClientEnvironmentSchema },
});
export type ClientManifest = typeof ClientManifestSchema.infer;

export interface ClientSecrets {
  betterAuthSecret: string;
  hubSigningKeys: string;
  sidecarToken: string;
}

export interface ServiceEnvPlan {
  hub: Record<string, string>;
  sidecar: Record<string, string>;
  web: Record<string, string>;
}

export type ServiceName = keyof ServiceEnvPlan;

// Keys whose value is a generated secret. On re-apply these must never be
// rotated blindly — an existing deployment's sessions and hub↔sidecar link
// break if they change. The CLI reuses existing values for these.
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "BETTER_AUTH_SECRET",
  "HUB_SIGNING_KEYS",
  "SIDECAR_TOKEN",
]);

const TOML = (Bun as unknown as { TOML: { parse(text: string): unknown } })
  .TOML;

export function parseManifest(tomlText: string): ClientManifest {
  const raw = TOML.parse(tomlText);
  const result = ClientManifestSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid client manifest: ${result.summary}`);
  }
  return result;
}

export function selectEnvironment(
  manifest: ClientManifest,
  environment: string,
): ClientEnvironment {
  const env = manifest.environments[environment];
  if (!env) {
    const available = Object.keys(manifest.environments).join(", ") || "(none)";
    throw new Error(
      `Environment "${environment}" not found in manifest. Available: ${available}`,
    );
  }
  return env;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateSecrets(): ClientSecrets {
  return {
    betterAuthSecret: randomHex(32),
    hubSigningKeys: `1:${randomHex(32)}`,
    sidecarToken: randomHex(32),
  };
}

// Derives the sidecar's hub WebSocket URL from the hub's public HTTP URL:
// https → wss, http → ws, path fixed to the sidecar mount point.
export function hubWsUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/sidecars/ws";
  return url.toString();
}

// A URL still carrying the manifest placeholder token — services must be
// created and their domains filled in before provisioning can run.
export function isPlaceholderUrl(url: string): boolean {
  return url.includes("REPLACE");
}

export function assertResolvedUrls(env: ClientEnvironment): void {
  const unresolved = (["hub_url", "web_url"] as const).filter((k) =>
    isPlaceholderUrl(env[k]),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved placeholder URL(s): ${unresolved.join(", ")}. Create the ` +
        `Railway services first, then fill their public domains into the manifest.`,
    );
  }
}

export function buildEnvPlan(
  env: ClientEnvironment,
  secrets: ClientSecrets,
): ServiceEnvPlan {
  const appEnv = env.app_env ?? "production";
  return {
    // DATABASE_URL is injected by the Railway Postgres plugin — never set here.
    hub: {
      PORT: "4000",
      GLOBAL_TENANT_SLUG: env.slug,
      GLOBAL_TENANT_NAME: env.name,
      GLOBAL_TENANT_DOMAIN: env.domain,
      BETTER_AUTH_SECRET: secrets.betterAuthSecret,
      BETTER_AUTH_BASE_URL: env.hub_url,
      SUPPORTED_CORS_ORIGINS: env.web_url,
      HUB_DATA_DIR: "/data",
      HUB_SIGNING_KEYS: secrets.hubSigningKeys,
      SIDECAR_TOKEN: secrets.sidecarToken,
    },
    sidecar: {
      SIDECAR_ID: `${env.slug}-sidecar-1`,
      SIDECAR_TOKEN: secrets.sidecarToken,
      HUB_WS_URL: hubWsUrl(env.hub_url),
      SIDECAR_DATA_DIR: "/data",
    },
    web: {
      VITE_API_BASE_URL: env.hub_url,
      VITE_APP_ENV: appEnv,
    },
  };
}

export interface RailwayApplyOptions {
  services: Record<ServiceName, string>;
  environment: string;
  project?: string;
  // "<serviceName>:<KEY>" pairs already present in Railway — secret keys in this
  // set are left untouched so re-apply never rotates a live deployment's secrets.
  existing?: ReadonlySet<string>;
}

// Builds the exact `railway variables --set ...` argv arrays (minus the leading
// "railway") for the plan. Pure and unit-tested so the apply path's commands are
// verified even without a live Railway project.
export function buildRailwayVariableCommands(
  plan: ServiceEnvPlan,
  opts: RailwayApplyOptions,
): string[][] {
  const commands: string[][] = [];
  for (const service of ["hub", "sidecar", "web"] as const) {
    const serviceName = opts.services[service];
    for (const [key, value] of Object.entries(plan[service])) {
      if (SECRET_KEYS.has(key) && opts.existing?.has(`${serviceName}:${key}`)) {
        continue;
      }
      const argv = [
        "variables",
        "--set",
        `${key}=${value}`,
        "--service",
        serviceName,
        "--environment",
        opts.environment,
        "--skip-deploys",
      ];
      if (opts.project) {
        argv.push("--project", opts.project);
      }
      commands.push(argv);
    }
  }
  return commands;
}
