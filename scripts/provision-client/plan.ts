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
  // Optional public app URL. Present when the web app is served from a separate
  // origin (e.g. Vercel) — it becomes the auth base + CORS origin. Absent when
  // the hub serves the SPA itself, in which case the hub URL is the public
  // origin. The provisioning script never configures a web service either way.
  "web_url?": "string > 0",
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

// The provisioning script owns only the Railway hub and sidecar services. The
// web app is deployed separately (Vercel, or baked into the hub image) and is
// never a Railway service this script configures.
export interface ServiceEnvPlan {
  hub: Record<string, string>;
  sidecar: Record<string, string>;
}

export type ServiceName = keyof ServiceEnvPlan;

export const SERVICES = ["hub", "sidecar"] as const;

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
  const urls: [string, string][] = [["hub_url", env.hub_url]];
  if (env.web_url !== undefined) urls.push(["web_url", env.web_url]);
  const unresolved = urls
    .filter(([, url]) => isPlaceholderUrl(url))
    .map(([k]) => k);
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved placeholder URL(s): ${unresolved.join(", ")}. Create the ` +
        `Railway services first, then fill their public domains into the manifest.`,
    );
  }
}

// The origin the browser actually uses: the separate web URL when the SPA is
// served elsewhere (Vercel), else the hub's own URL when the hub serves the SPA.
// Drives the auth base and CORS; the sidecar always talks to the hub directly.
export function publicOrigin(env: ClientEnvironment): string {
  return env.web_url ?? env.hub_url;
}

export function buildEnvPlan(
  env: ClientEnvironment,
  secrets: ClientSecrets,
): ServiceEnvPlan {
  const origin = publicOrigin(env);
  return {
    // DATABASE_URL is injected by the Railway Postgres plugin — never set here.
    hub: {
      PORT: "4000",
      GLOBAL_TENANT_SLUG: env.slug,
      GLOBAL_TENANT_NAME: env.name,
      GLOBAL_TENANT_DOMAIN: env.domain,
      BETTER_AUTH_SECRET: secrets.betterAuthSecret,
      BETTER_AUTH_BASE_URL: origin,
      SUPPORTED_CORS_ORIGINS: origin,
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
  for (const service of SERVICES) {
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
