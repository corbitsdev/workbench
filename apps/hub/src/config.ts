import { type } from "arktype";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "config"]);

// Boot-time workflow-def auto-publish routing (CL-2641): maps a workflow `kind`
// (or the literal key "default") to the tenant SLUGS it should be published
// into. Slugs (not ids) so a single value works across staging and prod. When
// the env is unset/empty every def falls back to the global root tenant — the
// exact pre-CL-2641 behavior — so back-compat is preserved.
export const WorkflowAutopublishMapSchema = type({
  "[string]": "string[]",
});
export type WorkflowAutopublishMap = typeof WorkflowAutopublishMapSchema.infer;

// Optional by contract: unset or blank → null ("no map" → default routing).
// When set, malformed JSON or a wrong shape fails config load loudly — this is
// a deploy-config boundary and config.ts owns validation.
function parseWorkflowAutopublishMap(): WorkflowAutopublishMap | null {
  const raw = process.env["WORKFLOW_AUTOPUBLISH_MAP"];
  if (raw === undefined || raw.trim() === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `WORKFLOW_AUTOPUBLISH_MAP must be valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parsed = WorkflowAutopublishMapSchema(json);
  if (parsed instanceof type.errors) {
    throw new Error(
      `WORKFLOW_AUTOPUBLISH_MAP has an invalid shape (expected an object mapping a workflow kind or "default" to an array of tenant slugs): ${parsed.summary}`,
    );
  }
  return parsed;
}
// Keep `config` a dependency-light leaf: importing these constants from
// `./services/agent-provisioning` would drag that module's heavy graph
// (tool-registry ↔ file-parser-tools has a mutual cycle) into config and flip
// module load order, TDZ-crashing unrelated suites. These literals are the
// contract-guaranteed defaults; they mirror DEFAULT_WEDGE_SWEEP_INTERVAL_MS and
// DEFAULT_UNROUTABLE_GRACE_MS in agent-provisioning (the reconciler's own
// fallbacks), which must stay in sync.
const DEFAULT_WEDGE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_WEDGE_UNROUTABLE_GRACE_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name: string): boolean {
  const value = process.env[name];
  return value === "true" || value === "1";
}

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer (milliseconds); got "${raw}"`,
    );
  }
  return parsed;
}

function originOf(url: string): string {
  return new URL(url.endsWith("/") ? url : `${url}/`).origin;
}

export function loadConfig() {
  const isDev = process.env["NODE_ENV"] !== "production";

  const corsOrigins = parseOrigins(optionalEnv("SUPPORTED_CORS_ORIGINS"));
  const authBaseUrl = requireEnv("BETTER_AUTH_BASE_URL");
  const authOrigin = originOf(authBaseUrl);
  const authServedFromWebApp = corsOrigins.some(
    (origin) => originOf(origin) === authOrigin,
  );

  if (!isDev && corsOrigins.length === 0) {
    throw new Error(
      "SUPPORTED_CORS_ORIGINS must be set in production (comma-separated list of allowed origins)",
    );
  }

  const googleClientId = optionalEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = optionalEnv("GOOGLE_CLIENT_SECRET");

  if (googleClientId && !googleClientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set",
    );
  }
  if (googleClientSecret && !googleClientId) {
    throw new Error(
      "GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set",
    );
  }

  const config = {
    isDev,
    port: requireEnv("PORT"),
    sidecarToken: requireEnv("SIDECAR_TOKEN"),
    auth: {
      secret: requireEnv("BETTER_AUTH_SECRET"),
      baseUrl: authBaseUrl,
      servedFromWebApp: authServedFromWebApp,
      useCrossSiteCookies:
        !isDev && corsOrigins.length > 0 && !authServedFromWebApp,
    },
    cors: {
      origins: corsOrigins,
      isCrossOrigin: corsOrigins.length > 0,
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      allowedDomains: parseOrigins(optionalEnv("GOOGLE_ALLOWED_DOMAINS")),
    },
    granola: {
      baseUrl: "https://public-api.granola.ai/v1",
    },
    // Error reporting. Optional: when SENTRY_DSN is unset, Sentry and its log
    // sink are a no-op (see setupObservability). Read directly by initSentry at
    // startup; mirrored here for visibility. Default environment is 'production'.
    sentry: {
      dsn: optionalEnv("SENTRY_DSN"),
      environment: optionalEnv("SENTRY_ENVIRONMENT") ?? "production",
    },
    databaseUrl: requireEnv("DATABASE_URL"),
    hub: {
      dataDir: requireEnv("HUB_DATA_DIR"),
      signingKeys: requireEnv("HUB_SIGNING_KEYS"),
    },
    // The deployment's root tenant — the default home every user lands in.
    // Name/slug/domain are deployment-specific and never hardcoded; a different
    // deployment produces a different org from the same code. See CL-1446. The
    // env var KEYS stay GLOBAL_TENANT_* (renaming them would break the deploy at
    // boot); only the internal property is `rootTenant`. `globalTenant` is kept
    // as a back-compat alias for the one-off global-tenant migration.
    rootTenant: {
      slug: requireEnv("GLOBAL_TENANT_SLUG"),
      name: requireEnv("GLOBAL_TENANT_NAME"),
      domain: requireEnv("GLOBAL_TENANT_DOMAIN"),
    },
    get globalTenant() {
      return this.rootTenant;
    },
    // Build SHA injected by Railway at image build time via RAILWAY_GIT_COMMIT_SHA.
    // Absent in local dev — null is the correct value there.
    buildSha: optionalEnv("RAILWAY_GIT_COMMIT_SHA") ?? null,
    // When true, the hub publishes its embedded (build-serialized) workflow
    // definitions to the global tenant on boot (CL-2593). Default false — an
    // opt-in kill switch; off restores the manual `deploy-workflow` flow.
    workflowAutopublishOnBoot: parseBooleanEnv("WORKFLOW_AUTOPUBLISH_ON_BOOT"),
    // Per-kind → tenant-slug routing for boot-time autopublish (CL-2641). Null
    // when unset → every def targets the global root tenant (back-compat).
    workflowAutopublishMap: parseWorkflowAutopublishMap(),
    // Cadence (ms) of the periodic wedge-sweep reconciler that relaunches agent
    // instances left with an active session but no routable sidecar address
    // after a sidecar restart (CL-2639). Single contract-guaranteed default of
    // 30s; override with WEDGE_SWEEP_INTERVAL_MS (positive integer milliseconds).
    wedgeSweepIntervalMs: parsePositiveIntEnv(
      "WEDGE_SWEEP_INTERVAL_MS",
      DEFAULT_WEDGE_SWEEP_INTERVAL_MS,
    ),
    // How long (ms) an address must stay continuously unroutable before the
    // wedge sweep ends-and-relaunches it. Must exceed the 90s disconnect grace
    // and typical sidecar reconnect-settle time so a healthy redeploy reconnect
    // clears the tracker before we act. Default 120s; override with
    // WEDGE_UNROUTABLE_GRACE_MS (positive integer milliseconds).
    wedgeUnroutableGraceMs: parsePositiveIntEnv(
      "WEDGE_UNROUTABLE_GRACE_MS",
      DEFAULT_WEDGE_UNROUTABLE_GRACE_MS,
    ),
  };

  log.info("Configuration loaded", {
    isDev,
    port: config.port,
    corsOrigins: config.cors.origins,
    googleAuthEnabled: Boolean(config.google.clientId),
    authServedFromWebApp: config.auth.servedFromWebApp,
  });

  if (!isDev && config.google.clientId && config.auth.useCrossSiteCookies) {
    log.warn(
      "BETTER_AUTH_BASE_URL does not match SUPPORTED_CORS_ORIGINS — OAuth state cookies are cross-site and often fail on mobile Safari. Set BETTER_AUTH_BASE_URL to your public web URL, proxy /api on the web service (HUB_URL), and leave VITE_API_BASE_URL unset at web build time.",
      { authOrigin, corsOrigins: config.cors.origins },
    );
  }

  _config = config;
  return config;
}

export function getConfig(): Config {
  if (!_config)
    throw new Error(
      "Config not loaded — call loadConfig() at startup before use",
    );
  return _config;
}

let _config: Config | undefined;

export type Config = ReturnType<typeof loadConfig>;
