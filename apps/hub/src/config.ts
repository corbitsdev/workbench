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
// Write-path GC for the hub's agent-state repos (mirrors the upstream
// reference hub's HUB_AGENT_GC_* knobs). Each accepted state pack strands
// the prior tip's objects and adds a pack, and each deploy commit strands
// loose objects; left alone the repo grows without bound. The hub reclaims
// on the write path once a repo crosses HUB_AGENT_GC_PACK_THRESHOLD packs
// or HUB_AGENT_GC_LOOSE_THRESHOLD loose objects, and warns once it crosses
// HUB_AGENT_GC_WARN_BYTES. Retention is fixed to keep-history at the store
// wiring and not operator-configurable: the hub is the long-term archive of
// an agent's state graph, and tip-only would prune the commit ancestry the
// hub's subscriber-seq and history replay derive from git.log.
const DEFAULT_HUB_AGENT_GC_PACK_THRESHOLD = 64;
const DEFAULT_HUB_AGENT_GC_LOOSE_THRESHOLD = 2048;
const DEFAULT_HUB_AGENT_GC_WARN_BYTES = 256 * 1024 * 1024;

const DEFAULT_WEDGE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_WEDGE_UNROUTABLE_GRACE_MS = 120_000;

// CL-2756 awaiting-supervisor pre-warm backstop cadence (mirrors the reconciler's
// DEFAULT_AWAITING_PREWARM_INTERVAL_MS). 30s: a gate-parked supervisor is
// re-established well before a human returns to the gate; each tick no-ops for
// already-routable supervisors.
const DEFAULT_AWAITING_PREWARM_INTERVAL_MS = 30_000;

// CL-2727 run liveness sweep. Generous defaults so a healthy-but-slow run is
// never failed: a GONE supervisor with no progress is orphaned past the grace,
// while a ROUTABLE supervisor with no progress (a slow first step) is left alone
// until the far longer hard deadline. See run-liveness-sweep.ts for the full
// predicate.
const DEFAULT_RUN_LIVENESS_STALL_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_RUN_LIVENESS_START_HARD_DEADLINE_MS = 20 * 60 * 1000;
const DEFAULT_RUN_LIVENESS_INTERVAL_MS = 60 * 1000;

// CL-2790 idle chat-session reaper. `reapAfterMs`: a live chat session with no
// activity for this long is slept (undeployed, session ended, instance left
// relaunchable). `intervalMs`: how often the sweep runs. CL-2795 made the reaper
// always-on (the former `IDLE_SESSION_REAP_ENABLED` kill switch is gone) and
// dropped the threshold to 5 minutes, swept every minute; an in-flight-turn
// guard spares any agent mid-work. Both knobs stay env-tunable.
const DEFAULT_IDLE_SESSION_REAP_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_SESSION_REAP_INTERVAL_MS = 60 * 1000;

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

function parseAutoJoinTenantSlugs(): string[] {
  const raw = process.env["AUTO_JOIN_TENANT_SLUGS"];
  if (!raw || raw.trim() === "") return [];
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const part of raw.split(",")) {
    const slug = part.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

function parseBooleanEnv(name: string): boolean {
  const value = process.env[name];
  return value === "true" || value === "1";
}

function parsePositiveIntEnv(
  name: string,
  defaultValue: number,
  unitHint?: string,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const unit = unitHint === undefined ? "" : ` (${unitHint})`;
    throw new Error(`${name} must be a positive integer${unit}; got "${raw}"`);
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
    // models.dev open pricing database (CL-2714). Fetched + cached hub-side and
    // exposed via /api/tenants/:tenantId/pricing so the browser never hits
    // models.dev directly (CSP). URLs are contract-guaranteed defaults;
    // overridable for tests/mirrors. TTL defaults to 6 hours — prices change
    // rarely and the shared hub should not refetch a 3MB payload per request.
    pricing: {
      apiUrl:
        optionalEnv("MODELS_DEV_API_URL") ?? "https://models.dev/api.json",
      logosBaseUrl:
        optionalEnv("MODELS_DEV_LOGOS_URL") ?? "https://models.dev/logos",
      ttlMs: parsePositiveIntEnv("MODELS_DEV_TTL_MS", 6 * 60 * 60 * 1000),
      // Abort a hung models.dev fetch so it cannot wedge every pricing request
      // behind a never-resolving in-flight promise.
      fetchTimeoutMs: parsePositiveIntEnv("MODELS_DEV_TIMEOUT_MS", 10_000),
    },
    // Insights (CL-2753). The tenant-wide activity feed runs the heaviest
    // Insights query — a per-row UNION across un-indexable interchange tables.
    // A short in-process TTL memoizes the tenant-wide FIRST page so N members
    // opening the feed within the window collapse to one DB union instead of
    // one per open. Only the redacted tenant-wide first page is cached; deep
    // (cursor) pages and per-principal drill-downs are never memoized.
    insights: {
      tenantActivityCacheTtlMs: parsePositiveIntEnv(
        "INSIGHTS_TENANT_ACTIVITY_CACHE_TTL_MS",
        45_000,
      ),
    },
    // Workflow deploy caches (CL-2760). Model-source catalog resolution and the
    // parsed+validated workflow definition are both recomputed on every provision
    // AND every re-establish. Short in-process TTLs collapse that redundant work.
    // The TTLs are deliberately short — long enough to absorb a burst of
    // run-starts, short enough that an operator catalog change is picked up within
    // the window rather than masked. The definition cache is keyed on (kind,
    // mtime) but ALSO carries a TTL backstop: a checkout/restore that preserves
    // mtime while changing content cannot serve a stale definition past the TTL.
    workflowDeploy: {
      modelSourceCacheTtlMs: parsePositiveIntEnv(
        "WORKFLOW_MODEL_SOURCE_CACHE_TTL_MS",
        45_000,
      ),
      definitionCacheTtlMs: parsePositiveIntEnv(
        "WORKFLOW_DEFINITION_CACHE_TTL_MS",
        45_000,
      ),
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
      agentGc: {
        packThreshold: parsePositiveIntEnv(
          "HUB_AGENT_GC_PACK_THRESHOLD",
          DEFAULT_HUB_AGENT_GC_PACK_THRESHOLD,
        ),
        looseThreshold: parsePositiveIntEnv(
          "HUB_AGENT_GC_LOOSE_THRESHOLD",
          DEFAULT_HUB_AGENT_GC_LOOSE_THRESHOLD,
        ),
        warnBytes: parsePositiveIntEnv(
          "HUB_AGENT_GC_WARN_BYTES",
          DEFAULT_HUB_AGENT_GC_WARN_BYTES,
        ),
      },
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
    // Tenants to auto-join on signup/login (comma-separated slugs). Default empty
    // — no implicit org membership. Set to the global slug to preserve legacy
    // "everyone joins root" behavior until admin invite rules land (CL-2855).
    autoJoinTenantSlugs: parseAutoJoinTenantSlugs(),
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
      "milliseconds",
    ),
    // How long (ms) an address must stay continuously unroutable before the
    // wedge sweep ends-and-relaunches it. Must exceed the 90s disconnect grace
    // and typical sidecar reconnect-settle time so a healthy redeploy reconnect
    // clears the tracker before we act. Default 120s; override with
    // WEDGE_UNROUTABLE_GRACE_MS (positive integer milliseconds).
    wedgeUnroutableGraceMs: parsePositiveIntEnv(
      "WEDGE_UNROUTABLE_GRACE_MS",
      DEFAULT_WEDGE_UNROUTABLE_GRACE_MS,
      "milliseconds",
    ),
    // CL-2756 awaiting-supervisor pre-warm backstop. How often the periodic
    // sweep re-establishes gate-parked (`awaiting`) supervisors that are
    // unroutable, so a human's gate-resume finds the supervisor already routable
    // and pays no re-establish on the critical path. Default 30s; override with
    // AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS (positive integer milliseconds).
    awaitingSupervisorPrewarmIntervalMs: parsePositiveIntEnv(
      "AWAITING_SUPERVISOR_PREWARM_INTERVAL_MS",
      DEFAULT_AWAITING_PREWARM_INTERVAL_MS,
      "milliseconds",
    ),
    // CL-2727 continuous run liveness sweep. `stallGraceMs`: a GONE-supervisor
    // run must be idle at least this long before it is orphan-failed (also the
    // candidate-scan cutoff). `startHardDeadlineMs`: a ROUTABLE-supervisor run
    // that has made NO progress is only failed past this far longer deadline —
    // a slow first step under it is left alone (the false-positive fix).
    // `intervalMs`: how often the loop runs. Override with RUN_LIVENESS_*.
    runLivenessSweep: {
      stallGraceMs: parsePositiveIntEnv(
        "RUN_LIVENESS_STALL_GRACE_MS",
        DEFAULT_RUN_LIVENESS_STALL_GRACE_MS,
        "milliseconds",
      ),
      startHardDeadlineMs: parsePositiveIntEnv(
        "RUN_LIVENESS_START_HARD_DEADLINE_MS",
        DEFAULT_RUN_LIVENESS_START_HARD_DEADLINE_MS,
        "milliseconds",
      ),
      intervalMs: parsePositiveIntEnv(
        "RUN_LIVENESS_INTERVAL_MS",
        DEFAULT_RUN_LIVENESS_INTERVAL_MS,
        "milliseconds",
      ),
    },
    // CL-2790/CL-2795 idle chat-session reaper. Always-on; an in-flight-turn
    // guard spares any agent mid-work. Override thresholds with
    // IDLE_SESSION_REAP_AFTER_MS / IDLE_SESSION_REAP_INTERVAL_MS.
    idleSessionReaper: {
      reapAfterMs: parsePositiveIntEnv(
        "IDLE_SESSION_REAP_AFTER_MS",
        DEFAULT_IDLE_SESSION_REAP_AFTER_MS,
        "milliseconds",
      ),
      intervalMs: parsePositiveIntEnv(
        "IDLE_SESSION_REAP_INTERVAL_MS",
        DEFAULT_IDLE_SESSION_REAP_INTERVAL_MS,
        "milliseconds",
      ),
    },
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
