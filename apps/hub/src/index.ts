// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
  type DB,
} from "@intx/db";
import { sidecar, tenant as tenantTable, workflowDefinition, workflowRun } from "@intx/db/schema";
import { and, eq } from "drizzle-orm";
import { createEnvKeyCredentialCipher, createNoopCredentialCipher, sha256 } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import {
  createApp,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";
// CL-7362: computes the preview's wire hash from the probed-but-unapproved
// projection `installAndApproveWorkflowSource` returns on `grants_not_approved`
// — the gate itself only stamps this hash on the `ok:true` arm.

import { reportError } from "@corbits/error-sink";
import { decodedOrNull } from "@corbits/url-path";
import {
  buildMailFrame,
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  generateMailboxMessageId,
  mountMailbox,
} from "@corbits/mailbox";
import { createMemory, loadMemoryConfig } from "@corbits/memory";
import { applyCronMigrations, createCronTicker, mountCron } from "@corbits/cron";
import {
  createHubMailboxAuthorizeSender,
  createHubPersistMailWithSessionEnsure,
} from "./mailbox-persist";
import {
  createDrizzleWebhookTriggerStore,
  createWebhookIngressRoutes,
  createWebhookTriggerRoutes,
  launchWebhookTrigger,
  createCryptoProviderCache,
} from "@corbits/webhook-triggers";
import { ensureRunSession } from "@corbits/workflows";
import {
  createSidecarProvisioner as createE2BSidecarProvisioner,
  readProvisionerConfig as readE2BProvisionerConfig,
} from "@corbits/e2b-sandbox-sidecar";
import {
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarPluginRegistry,
  createSidecarCredentialResolver,
  createSidecarRouter,
  createWorkflowAllocationService,
  createWorkflowDispatchService,
  resolveRoutableAddress,
  type EventCollectorRegistry,
  type WsHandle,
} from "@intx/hub-sessions";
import { generateKeyPair } from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";

// The same condition registry `mountHubRoutes` builds by default when no
// registry is supplied (`vendor/intx/hub-api/src/app.ts`) -- kept as one
// local constant so every route factory below shares the identical
// registry, rather than each re-deriving stock's own default.
const grantConditionRegistry: ConditionRegistry = {
  time_window: timeWindowEvaluator,
};
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import { createDockerSidecarProvisioner } from "@corbits/docker-provisioner";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
  type ProcessProvisionerRole,
} from "@corbits/process-provisioner";
import {
  InlineContentStore,
  mountArtifacts,
  mountWorkflowArtifacts,
  runArtifactMigrations,
  type WorkflowArtifactEnv,
} from "@corbits/artifacts";
import {
  artifactMatchesLibraryKindSegment,
  LIBRARY_KIND_SEGMENTS,
} from "@corbits/artifact-ui/kind-filter";
import {
  createConnectionRoutes,
  createMcpOAuthRoutes,
  createMcpServerRoutes,
  createOAuthConnectRoutes,
  createOAuthLoopbackRoutes,
  createTenantConnectCredential,
  createWorkflowConnectionRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  listMcpServerConnections,
} from "@corbits/connections";
import { CONNECTOR_REGISTRY, MCP_PRESETS } from "./native-connector-registry";
import { createProviderHealthStore } from "@corbits/connections/provider-health";
import { createWorkflowAuthorRegistry, createWorkflowAuthorRoutes } from "@corbits/workflows";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, Hono, type Next } from "hono";

import { upgradeWebSocket, websocket } from "hono/bun";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";
import {
  assertHubDataDirGitSafety,
  readHubConfig,
  type HubConfig,
  type SidecarProvisionerConfig,
} from "./config";
import type { SidecarProvisioner } from "@intx/hub-sessions";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const REGISTRIES = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);

// The one concrete `WorkflowRunAuthenticator` every workflow-run-authenticated
// surface in this app takes structurally (agent-directory, chat, connections,
// memory-hub, `@corbits/artifacts`' `mountWorkflowArtifacts`, and stock
// `@intx/hub-api`'s own `workflowRunAuthenticator` deploy mount): a sidecar
// bearer token + run address resolve to the tenant/principal/run it names.
function createWorkflowRunAuthenticator(deps: { db: DB["db"] }) {
  return {
    async resolve(token: string, runAddress: string) {
      if (token === "" || runAddress === "") return null;
      const tokenHash = await sha256(token);
      const sidecarRow = await deps.db.query.sidecar.findFirst({
        where: eq(sidecar.tokenHashSha256, tokenHash),
      });
      if (sidecarRow === undefined) return null;
      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;
      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}
// In-repo tool packages (`tools/granola`, `tools/linear`,
// `tools/skills-tools`) are unpublished to npm and stay that way:
// they are integration bundles for this product's own routes, not
// general-purpose npm packages, so publishing them to a public registry would be the
// wrong distribution surface for what they are. `@intx/hub-sessions`
// already resolves any `package-registry`-kind asset visible to a
// tenant as a named tool-package registry (see `session-service.ts`'s
// `buildAndResolve`), ahead of the statically-configured HTTP
// registries on a name collision — the platform-native alternative to
// npm publishing the CL-5999 capability audit called for. Routing the
// `@corbits` scope at this registry name means a `@corbits/*` pin
// resolves only once an operator publishes a `package-registry` asset
// named `CORBITS_TOOLS_REGISTRY` with the package's tarball —
// `@corbits/tool-registry-publish` is the publisher. Descendants
// inherit it, and `seedTenant` does not pack. Until then, resolution fails loud
// rather than silently falling through to npmjs (which could never
// carry an unpublished scope anyway).
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
// CL-8187: idle hibernation is the sidecar's own decision now — it tracks
// per-run last activity itself and tears an idle run down with a
// state-preserving teardown, keeping the deployment record, step-state,
// and slug so a later `wakeByAddress` relaunch resumes the same run
// rather than starting a fresh one. The hub no longer drives this at
// all: `createHubChatPlatform` carries no idle-reap wiring.

// Email+password signup stays available through better-auth; the hub
// applies only coarse throttling around it, never an operator gate.
// Email delivery of invites is out of scope.
// Email+password sign-in is always wired up. Google/GitHub OAuth are
// wired up too, but only the providers `readHubConfig` found a full
// credential pair for — better-auth's own `socialProviders` map is
// literally the set config.socialProviders resolved to, so a provider
// with no credential here never appears on the hub's auth handler no
// matter what the client asks for. OTP verification returns once a
// transactional-email credential and real UI exist for it; wiring it
// in ahead of that would be dead surface that also risks logging a
// verification secret with nowhere honest to send it.
function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

// Serves the single-page application from the hub origin: a real file
// when one exists, index.html otherwise so client-side routes deep-link,
// and never anything under /api, which stays with the platform routes.
export function createStaticHandler(staticDir: string) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    const decodedPath = decodedOrNull(c.req.path);
    if (decodedPath === null) return next();
    const rel = path.normalize(decodedPath).replace(/^[/\\]+/, "");
    if (rel === ".." || rel.startsWith(`..${path.sep}`)) return next();
    const asset = Bun.file(path.join(staticDir, rel));
    if (await asset.exists()) return new Response(asset);
    const index = Bun.file(path.join(staticDir, "index.html"));
    if (await index.exists()) return new Response(index);
    return next();
  };
}

/**
 * The `CredentialCipher` (see `@intx/types`) every secret-at-rest seam
 * in this composition root shares — currently `webhookTriggerStore`'s
 * signing secrets (CL-8112 unmounted the onboarding router whose OAuth
 * connect state and `pending_seed` table used to share it).
 * A real key (`CREDENTIAL_ENCRYPTION_KEY`) builds an AES-256-GCM
 * cipher. An unset key hard-fails boot — a self-hosting operator who
 * forgets this variable must not silently end up storing those secrets
 * in the clear — unless `ALLOW_PLAINTEXT_SECRETS` opts into the
 * identity no-op cipher with a boot warning, for dev/test only.
 */
export function credentialCipherFrom(
  config: HubConfig,
  log: ReturnType<typeof getLogger>,
): CredentialCipher {
  if (config.credentialEncryptionKeyHex === undefined) {
    if (!config.allowPlaintextSecrets) {
      throw new Error(
        [
          "CREDENTIAL_ENCRYPTION_KEY is not set.",
          "It encrypts secrets at rest — webhook-trigger signing secrets —",
          "so the hub refuses to boot without it. Generate one and",
          "add it to .env:",
          "",
          "  openssl rand -hex 32",
          "",
          "For local dev/test only, set ALLOW_PLAINTEXT_SECRETS=1 instead to",
          "boot with those secrets stored unencrypted; never do this for a",
          "real deployment.",
        ].join("\n"),
      );
    }
    log.warn`No CREDENTIAL_ENCRYPTION_KEY configured; secrets (e.g. webhook-trigger signing secrets) will NOT be encrypted at rest. ALLOW_PLAINTEXT_SECRETS is set — expected in dev/test only, never for a real deployment.`;
    return createNoopCredentialCipher();
  }
  return createEnvKeyCredentialCipher(Buffer.from(config.credentialEncryptionKeyHex, "hex"));
}

/**
 * Hub-boot mint of the per-principal signing-key store: seals every minted
 * signing key's private seed under `PRINCIPAL_KEY_ENCRYPTION_KEY` — a key
 * deliberately separate from `CREDENTIAL_ENCRYPTION_KEY` so the two rotate
 * independently. An unset key hard-fails boot for the same reason the
 * credential cipher does: a hub that forgets this variable must not
 * silently persist private keys in the clear — unless
 * `ALLOW_PLAINTEXT_SECRETS` opts into the identity no-op cipher with a
 * boot warning, for dev/test only.
 */
export function principalKeyStoreFrom(
  config: HubConfig,
  db: ReturnType<typeof createDB>["db"],
  log: ReturnType<typeof getLogger>,
) {
  if (config.principalKeyEncryptionKeyHex === undefined) {
    if (!config.allowPlaintextSecrets) {
      throw new Error(
        [
          "PRINCIPAL_KEY_ENCRYPTION_KEY is not set.",
          "It seals every principal's per-principal signing key at rest,",
          "so the hub refuses to boot without it. Generate one and add it",
          "to .env:",
          "",
          "  openssl rand -hex 32",
          "",
          "For local dev/test only, set ALLOW_PLAINTEXT_SECRETS=1 instead to",
          "boot with signing keys stored unencrypted; never do this for a",
          "real deployment.",
        ].join("\n"),
      );
    }
    log.warn`No PRINCIPAL_KEY_ENCRYPTION_KEY configured; per-principal signing keys will NOT be encrypted at rest. ALLOW_PLAINTEXT_SECRETS is set — expected in dev/test only, never for a real deployment.`;
    return createPrincipalKeyStore({
      db,
      cipher: createNoopCredentialCipher(),
    });
  }
  return createPrincipalKeyStore({
    db,
    cipher: createEnvKeyCredentialCipher(Buffer.from(config.principalKeyEncryptionKeyHex, "hex")),
  });
}

/**
 * Hub-boot mint of the process-wide credential cipher: build from
 * config, then runtime-tag the result. Missing or wrong-shape input
 * fails closed — the hub does not boot.
 */
export function hubCredentialCipher(
  config: HubConfig,
  log: ReturnType<typeof getLogger>,
): CredentialCipher {
  return credentialCipherFrom(config, log);
}

/**
 * Instantiates one configured sidecar-provisioner backend. This is the
 * extension point named in `.env.example` and `apps/hub/src/config.ts`:
 * a new backend gets a case here once its config member exists on
 * `SidecarProvisionerConfig`.
 */
function buildSidecarProvisioner(
  config: SidecarProvisionerConfig,
  hubDataDir: string,
  hubWebSocketUrl: string,
  role: ProcessProvisionerRole,
): SidecarProvisioner {
  switch (config.id) {
    case "process":
      // Same derivation as the other two backends: the hub-side
      // allocation state lives under the hub's own data dir, and so do
      // the per-allocation directories each spawned sidecar uses as its
      // own SIDECAR_DATA_DIR. Probe and deployment instances keep
      // separate state so neither can adopt the other's allocations.
      return createProcessSidecarProvisioner({
        role,
        config: readProcessProvisionerConfig({
          env: {
            ...(config.sidecarEntryPath === undefined
              ? {}
              : {
                  PROCESS_PROVISIONER_SIDECAR_ENTRY: config.sidecarEntryPath,
                }),
            ...(config.runtimePath === undefined
              ? {}
              : { PROCESS_PROVISIONER_RUNTIME: config.runtimePath }),
          },
          dataDir: path.resolve(
            hubDataDir,
            role === "probe" ? "process-provisioner-probe" : "process-provisioner",
          ),
          hubWebSocketUrl,
        }),
      });
    case "docker":
      return createDockerSidecarProvisioner({
        config: {
          image: config.image,
          stateFilePath: path.resolve(hubDataDir, "docker-provisioner", "state.json"),
        },
      });
    case "e2b":
      // Same derivation as docker's: the backend's hub-side allocation
      // state (generation fences, destroy tombstones, sandbox refs) lives
      // under the hub's own data dir. Distinct from the sandbox's own
      // SIDECAR_DATA_DIR, which start-sidecar.ts creates inside the VM.
      return createE2BSidecarProvisioner({
        config: readE2BProvisionerConfig(
          {
            E2B_API_KEY: config.apiKey,
            E2B_TEMPLATE: config.template,
            ...(config.sandboxTimeoutMs === undefined
              ? {}
              : { E2B_SANDBOX_TIMEOUT_MS: config.sandboxTimeoutMs }),
          },
          path.resolve(hubDataDir, "e2b-provisioner"),
        ),
      });
  }
}

export async function createHub(config: HubConfig) {
  assertHubDataDirGitSafety(config.hubDataDir, config.allowGitInsideWorkTree === true, process.env);
  const { db, close } = createDB(dbConfigFromUrl(config.databaseUrl));
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(config.databaseUrl);
  const mailboxBus = createInMemoryMailboxEventBus();
  const log = getLogger(["hub", "auth"]);
  // Built once, tagged, and shared by every secret-at-rest seam in this
  // composition root — see `hubCredentialCipher`.
  const credentialCipher = hubCredentialCipher(config, log);
  // Per-principal signing keys are sealed under their own operator key —
  // see `principalKeyStoreFrom`.
  const principalKeyStore = principalKeyStoreFrom(config, db, log);
  const auth = betterAuth({
    baseURL: config.baseUrl,
    secret: config.sessionSecret,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    socialProviders: config.socialProviders,
    // Client-IP resolution for the sign-up rate limit below. Railway's docs
    // (docs.railway.com/networking/public-networking/specs-and-limits) list
    // `X-Real-IP` as the header its edge sets for the client's address —
    // that's the only claim about it this codebase can actually stand
    // behind. It is deliberately NOT relied on for sign-in: Railway's
    // private networking lets any same-project service (sidecars included)
    // reach this hub directly, bypassing the edge, and with no
    // `trustedProxies` configured (Railway publishes no stable edge CIDR
    // list to populate one with) a single-value header is trusted verbatim
    // regardless of who set it. That's an acceptable, low-stakes gap for
    // sign-up's coarse throttling — an ungated path that needs only
    // brute-force resistance on sign-in, which is why
    // sign-in has its own account-keyed limiter instead (see
    // `sign-in-rate-limit.ts`).
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["x-real-ip"],
      },
    },
    rateLimit: {
      // Explicit and always on: better-auth's own default only enables
      // this in production (`enabled ?? isProduction`), which would
      // leave it silently untested in dev and CI. Loudly true here
      // instead of inferred from NODE_ENV.
      enabled: true,
      customRules: {
        [SIGN_UP_EMAIL_PATH]: {
          window: config.signupRateLimit.windowSeconds,
          max: config.signupRateLimit.max,
        },
        // Sign-in stays on better-auth's own IP-keyed rule (CL-8185: the
        // hub's account-keyed limiter working around its private-network
        // bypass was deleted; see "Upstream asks" for the gap).
      },
    },
  });
  const signingKey = await generateKeyPair();
  const agentRepoStore = createAgentRepoStore({
    dataDir: config.hubDataDir,
    signingKey,
  });
  const assetService = createAssetService({
    db,
    repoStore: agentRepoStore.repoStore,
    reservedPackageRegistryNames: new Set(REGISTRIES.keys()),
  });
  const baseLookups = createHubSessionLookups({ db, agentRepoStore });
  // A chat agent is a native provisioned deployment. Reconnect
  // ownership is Interchange's live run. Completed means dead; wake is a
  // fresh provision, not a folded-run idle settle.
  // Forward reference: `eventCollectors` (the wrapped
  // `EventCollectorRegistry`) isn't constructed until later in this
  // composition, but `createHubPersistMailWithSessionEnsure` below needs
  // it. Set once `eventCollectors` exists; every persistMail call before
  // that point (there are none — the server isn't serving requests yet)
  // would just no-op.
  const eventCollectorsRef: {
    current?: Pick<EventCollectorRegistry, "create" | "has">;
  } = {};
  // CL-6499 (native multi-step routines): materializes a mail-triggered
  // run's authorization grants from its deploy-approved snapshot, so
  // ANY plain mail delivered to a workflow deployment's address — not
  // only the dedicated `POST /workflows/:id/mail` HTTP trigger route,
  // which stages this itself inline — starts a properly authorized
  // run. Without this wired, `sidecarRouter.routeMail` alone would
  // deliver the mail but leave the run's `runs/<runId>/grants.json`
  // unwritten, and its `onRunStart` barrier would never resolve. This
  // is the one piece of plumbing `apps/hub/src/native-workflow-routine-launch.ts`
  // relies on to trigger a native multi-step deployment safely.
  const mailTriggeredRunGrants = createMailTriggeredRunGrantsMaterializer({
    db,
    principalKeyStore,
    grantStore: createGrantStore(db),
  });
  const lookups = {
    ...baseLookups,
    materializeMailTriggeredRunGrants: mailTriggeredRunGrants,
    // CL-7449: every outbound agent frame also lands a durable
    // `principal_mail` row in each addressed human participant's mailbox,
    // dual-written alongside `baseLookups.persistMail`'s `session_mail`
    // write. Dual-write independence is `createMailboxPersist`'s own
    // contract (upstream failing still attempts the mailbox write, and a
    // mailbox failure never fails upstream) -- no second try/catch belongs
    // here. This is also the seam the mailbox mount's own `deliver` below
    // reuses for `POST /me/inbox/send` (CL-8174): both a run's outbound
    // mail and a human's own sent mail land recipients through the same
    // dual-write path.
    persistMail: createMailboxPersist(mailboxDb, {
      upstream: createHubPersistMailWithSessionEnsure(
        db,
        eventCollectorsRef,
        baseLookups.persistMail,
      ),
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
    }),
  };
  const hubPublicKey = hexEncode(signingKey.publicKey);
  // One resolver serves both seams, exactly as @intx/hub-sessions's own
  // reference host wires them: `resolve` turns a presented bearer token
  // into a verified identity at the handshake, and `isCurrent`
  // revalidates that identity at the registration, readiness, and
  // routing boundaries. Without the second one the router falls back to
  // its always-true default, and a provisioner-issued token stays
  // accepted after its allocation was superseded or destroyed — which a
  // process-provisioned sidecar reaches easily, since a child that
  // outlives its allocation keeps reconnecting to the same hub.
  const sidecarCredentials = createSidecarCredentialResolver({ db });
  const sidecarRouter = createSidecarRouter({
    hubPublicKey,
    authenticateSidecar: async ({ token }) => sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    lookups,
    // CL-7508: a loopback login may only run on a sidecar whose allocation
    // was provisioned by the `process` backend — the only one that runs on
    // this host, where the user's browser can reach the pinned ports
    // (1455/1456). A docker/e2b-provisioned sidecar's localhost is the
    // container or the sandbox, never this machine, so it fails the gate
    // and the connect request gets the typed gate outcome.
    oauthLogin: {
      isLocalSidecar: async (identity) => {
        const allocation = await db.query.sidecarAllocation.findFirst({
          where: (allocation, { eq: equals }) => equals(allocation.id, identity.allocationId),
          columns: { provisionerId: true },
        });
        return allocation?.provisionerId === "process";
      },
    },
  });
  const isSidecarRoutable = (address: string) =>
    sidecarRouter.getRoutableAddresses().includes(address);
  // Process-lifetime provider-health signal (CL-6092): the one store
  // both the chat orchestrator's classified-failure port and
  // `GET .../connections/provider-health` read/write, so a runtime
  // failure a turn just reported is visible to the shell banner on its
  // very next poll. In-memory by design — see `provider-health.ts`'s own
  // header for why this never needs to survive a restart.
  const providerHealthStore = createProviderHealthStore();
  // Package-owned artifacts tables (CL-8188): idempotent, advisory-locked,
  // safe on every boot of every replica — see @corbits/artifacts' README.
  await runArtifactMigrations(db);
  // `@corbits/cron`'s own schema (CL-8183): idempotent, its own migration
  // ledger — see the package's README.
  await applyCronMigrations(config.databaseUrl);
  const artifactContentStore = InlineContentStore;
  const baseEventCollectors = createEventCollectorRegistry({
    db,
    // CL-7418: deliberately no terminal-status settle here. The folded
    // routine-fire settle (CL-6778, keyed off routines.routine_run) died
    // with the routines cut (CL-4455) and has no native equivalent: a
    // scheduled definition owns a single self-anchored workflow_run that
    // must stay live across fires — the scheduler launch path throws
    // NativeWorkflowDeploymentMissingError for a non-live anchor, and a
    // per-tick execution is a repo-local child run with no row of its
    // own (vendor's decideTerminalRunFlip skips it as skip_repo_local).
    // Stamping the anchor terminal per fire would brick the schedule,
    // so a warm-kept fire settles through the runOutcomeStatus /
    // FIRE_RUNNING_WINDOW_MS display-side reading instead.
  });
  // Wraps `dispatch` for CL-7480: a run's turn events can start arriving
  // before anything else ever recorded its session — the first inbound
  // trigger that just reconciled its principal races this same dispatch.
  // No live collector for the address is exactly that case: ensure the
  // session (and, inside it, the collector) before delegating, rather
  // than silently dropping the event for a collector that never gets
  // created. Every other method passes straight through.
  const eventCollectors: EventCollectorRegistry = {
    ...baseEventCollectors,
    dispatch(agentAddress, event) {
      if (!baseEventCollectors.has(agentAddress)) {
        void ensureCollectorThenDispatch(agentAddress, event);
        return;
      }
      baseEventCollectors.dispatch(agentAddress, event);
    },
  };
  eventCollectorsRef.current = eventCollectors;
  // Named so `dispatch`'s no-collector branch above reads clearly; not
  // inlined there because it needs to be `async` and `dispatch` itself
  // must stay synchronous (the `EventCollectorRegistry` contract).
  async function ensureCollectorThenDispatch(
    agentAddress: string,
    event: Parameters<EventCollectorRegistry["dispatch"]>[1],
  ): Promise<void> {
    try {
      const run = await resolveRoutableAddress(db, agentAddress);
      if (run !== undefined) {
        await ensureRunSession({
          db,
          eventCollectors: baseEventCollectors,
          runId: run.id,
        });
      }
    } catch (err) {
      reportError(err, {
        operation: "hub.eventCollectors.ensureRunSession",
        extra: { agentAddress },
      });
    }
    baseEventCollectors.dispatch(agentAddress, event);
  }
  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
  });
  // Shared-capacity `deployWorkflowFromSource` / `deployAdoptedWorkflowFromSource`
  // are gone on this pin. The provisioned path persists its source in
  // `workflow_run_launch_spec`; there is nothing left for a session-service
  // wrapper to record.
  const sessionService = createSessionService({
    sidecarRouter,
    sidecarAllocationRouter: sidecarRouter,
    agentRepoStore,
    assetService,
    db,
    toolPackageRegistries: {
      httpRegistries: REGISTRIES,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@corbits", registry: CORBITS_TOOLS_REGISTRY }],
    },
  });
  const hubWebSocketUrl =
    config.sidecarWebSocketUrl ?? `${config.baseUrl.replace(/^http/, "ws")}/api/sidecars/ws`;
  // Provisioner plugins are injected at the application composition
  // boundary, mirroring @intx/hub-sessions's own reference wiring. An
  // install that configures nothing registers the `process` backend
  // (`@corbits/process-provisioner`) as the sole default, so a
  // chat's "run this chat on its own sidecar" setting works on
  // one server with no operator setup; `SIDECAR_PROVISIONERS` is the one
  // variable that changes where sidecars run. A deployment whose
  // definition declares sidecar capabilities no registered provisioner
  // declares fails closed at provisioner selection rather than silently
  // landing on an unsuitable sidecar. Adding a new backend here is:
  // implement `SidecarProvisioner` in its own package, add a case to
  // `buildSidecarProvisioner`, and add its id to
  // `apps/hub/src/config.ts`'s `SIDECAR_PROVISIONER_IDS`.
  // Probes and deployments get distinct provisioner instances: when they
  // match, Interchange adopts the probe's allocation for the deployment,
  // and at pin 692c3106 that adopt path never deploys the workflow after
  // the sidecar reconnects (CL-7492).
  const buildSidecarPlugins = (role: ProcessProvisionerRole) =>
    createSidecarPluginRegistry({
      provisioners: config.sidecarProvisioners.map((provisionerConfig) =>
        buildSidecarProvisioner(provisionerConfig, config.hubDataDir, hubWebSocketUrl, role),
      ),
      ...(config.defaultSidecarProvisionerId !== undefined
        ? { defaultProvisionerId: config.defaultSidecarProvisionerId }
        : {}),
    });
  const sidecarPlugins = buildSidecarPlugins("deployment");
  const workflowAllocationService = createWorkflowAllocationService({
    db,
    deploymentPlugins: sidecarPlugins,
    probePlugins: buildSidecarPlugins("probe"),
    preparedDeployer: sessionService,
    credentialCipher,
    allocationRouter: sidecarRouter,
    hubWebSocketUrl,
  });
  const sidecarAllocationStore = createSidecarAllocationStore(db);
  const workflowDispatchService = createWorkflowDispatchService({
    dispatchStore: createWorkflowRunDispatchStore(db),
    allocationStore: sidecarAllocationStore,
    router: sidecarRouter,
    resolveAnchorAddress: async (anchorRunId) => {
      const row = await db.query.workflowRun.findFirst({
        where: (run, { eq: equals }) => equals(run.id, anchorRunId),
        columns: { address: true },
      });
      return row?.address ?? null;
    },
  });
  const sidecarAllocationReconciler = createSidecarAllocationReconciler({
    allocationStore: sidecarAllocationStore,
    plugins: sidecarPlugins,
    router: sidecarRouter,
    hubWebSocketUrl,
    onReady: async (allocation, reconciliation) => {
      await workflowAllocationService.deployReadyAllocation(allocation, reconciliation);
      await workflowDispatchService.requeueForReadyAllocation(allocation.anchorRunId);
    },
  });
  await workflowAllocationService.initialize?.();
  await sidecarAllocationReconciler.initialize();
  sidecarRouter.events.on("sidecar.disconnect", ({ allocated }) => {
    if (allocated === undefined) return;
    return sidecarAllocationReconciler.handleDisconnect(allocated);
  });
  sidecarRouter.events.on("sidecar.allocated.connected", (allocated) =>
    sidecarAllocationReconciler.handleConnected(allocated),
  );
  sidecarRouter.events.on("mail.inbound.acknowledged", ({ messageId, allocated }) => {
    if (allocated === undefined) return;
    return workflowDispatchService.acknowledge({ ...allocated, messageId });
  });
  const sidecarAllocationLog = getLogger(["hub", "sidecar-allocation"]);
  const ALLOCATION_RECONCILIATION_INTERVAL_MS = 1_000;
  const ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS = 30_000;
  let nextAllocationConnectionRepairAt = Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
  let sidecarAllocationReconciliationStopped = false;
  let sidecarAllocationReconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleAllocationReconciliation(delayMs: number): void {
    if (sidecarAllocationReconciliationStopped) return;
    const timer = setTimeout(() => {
      void reconcileSidecarAllocations();
    }, delayMs);
    timer.unref?.();
    sidecarAllocationReconciliationTimer = timer;
  }
  async function reconcileSidecarAllocations(): Promise<void> {
    try {
      await sidecarAllocationReconciler.reconcileUntilIdle();
      await workflowDispatchService.reconcileUntilIdle();
      if (Date.now() >= nextAllocationConnectionRepairAt) {
        nextAllocationConnectionRepairAt = Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
        await sidecarAllocationReconciler.repairUnscheduledConnections();
      }
    } catch (error) {
      sidecarAllocationLog.error`Sidecar allocation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      scheduleAllocationReconciliation(ALLOCATION_RECONCILIATION_INTERVAL_MS);
    }
  }
  scheduleAllocationReconciliation(ALLOCATION_RECONCILIATION_INTERVAL_MS);
  const app = createApp({
    workflowAllocationService,
    workflowDispatchService,
    credentialCipher,
    principalKeyStore,
    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: async (c) => auth.handler(c.req.raw),
    db,
    sidecarRouter,
    sessionService,
    eventCollectors,
    assetService,
    repoStore: agentRepoStore.repoStore,
    maxTarballBytes: MAX_TARBALL_BYTES,
    // Lets a workflow-run agent deploy through the same
    // `/workflows/deployments` route a human session uses (see
    // `@intx/hub-api`'s `workflow-run-deploy-auth` middleware) -- the same
    // sidecar-bearer + run-address credential every other workflow-run write
    // surface below already authenticates with.
    workflowRunAuthenticator: createWorkflowRunAuthenticator({ db }),
    sidecarWsHandler: upgradeWebSocket((_c) => {
      let handle: WsHandle;
      return {
        onOpen(_evt, ws) {
          handle = { send: (d: string) => ws.send(d), close: () => ws.close() };
          sidecarRouter.handleOpen(handle);
        },
        onMessage(evt, _ws) {
          if (typeof evt.data === "string") sidecarRouter.handleMessage(handle, evt.data);
        },
        onClose: () => sidecarRouter.handleClose(handle),
      };
    }),
  });

  // CL-8185: the hub-owned global `app.onError` (`hub-error-handler.ts`)
  // was deleted under the hub-sweep's less-is-more ruling. An exception
  // escaping a route now falls through to Hono's own built-in handler --
  // a bare 500 with nothing reported. See "Upstream asks".

  // The hub's own grant store, built the same way `createApp` builds its
  // default when none is supplied (see `@intx/hub-api`'s
  // `mountHubRoutes`). `createRequireGrant` is the published construction
  // the platform's own internal instance is not exported for.
  const grantStore = createGrantStore(db);
  const cryptoProviders = createCryptoProviderCache();
  // The `@corbits/inbox` product-inbox routes (triage groups, mark-all-read,
  // clear-done) are retired (CL-8209): they sat on `@corbits/mailbox` APIs
  // (`listUserMailbox`, refs, classification) removed in the native 1.0
  // cutover, and no web surface reads `${TENANT_PREFIX}/inbox` any more —
  // `/inbox` in the web app only bounces old links home (CL-6151). The
  // library's own `/me/inbox*` routes below are the whole inbox surface now.
  // Library/artifacts plane (CL-8188): `@corbits/artifacts` mounted directly
  // rather than through the retired `@corbits/artifacts-hub` wrapper — the
  // library now owns counts, preview, and every other Library HTTP surface
  // this app previously reimplemented. `countSegments` keeps the segment
  // taxonomy (what makes an artifact a "document" or a "routine") host-owned,
  // per the library's README; the predicates themselves live in
  // `@corbits/artifact-ui` so the web Files nav and this count walk share one
  // mapping.
  {
    const artifactsApi = new Hono<TenantEnv>();
    mountArtifacts(artifactsApi, {
      db,
      contentStore: artifactContentStore,
      requireGrant: createRequireGrant({
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
      countSegments: Object.fromEntries(
        LIBRARY_KIND_SEGMENTS.map((segment) => [
          segment,
          (row: { kind: string; title: string }) => artifactMatchesLibraryKindSegment(row, segment),
        ]),
      ),
    });
    app.route(TENANT_PREFIX, artifactsApi);
  }
  // Myra's own artifact tools (`@corbits/artifact-tools`, CL-6000) and every
  // Routine's own `finalize-tool`/`artifact-client` duplicate: the
  // workflow-run-authenticated counterpart to the tenant-session mount just
  // above, at the same `/api/workflow-artifacts` prefix the sidecar's
  // `hubArtifactsUrl` already points at. Every route lives under this
  // mount's own `/artifacts` prefix per `@corbits/artifacts`' fixed shape
  // (`POST /artifacts`, `GET /artifacts/recent`, `GET /artifacts/:id`,
  // `POST /artifacts/binary`) — callers reach it at
  // `/api/workflow-artifacts/artifacts...`.
  {
    const workflowArtifactsApi = new Hono<WorkflowArtifactEnv>();
    const workflowRunAuthenticator = createWorkflowRunAuthenticator({ db });
    mountWorkflowArtifacts(workflowArtifactsApi, {
      db,
      contentStore: artifactContentStore,
      resolveRunScope: (token, runAddress) => workflowRunAuthenticator.resolve(token, runAddress),
    });
    app.route("/api/workflow-artifacts", workflowArtifactsApi);
  }
  {
    const mailboxApp = new Hono<TenantEnv>();
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      resolvePrincipal: (ctx) => {
        // Mounted under the hub tenant middleware; principal + tenant are set.
        const c = ctx as {
          get(key: "tenant" | "principal"): { id: string };
        };
        return {
          tenantId: c.get("tenant").id,
          principalId: c.get("principal").id,
        };
      },
      // The caller's own address for `POST /me/inbox/send`'s `From:` — the
      // same `<principalId>@<tenant domain>` shape every other mailbox
      // writer in this file addresses a human principal under
      // (`mailbox-fanout.ts`'s `writeChatMailboxFanout`,
      // `native-workflow-routine-launch.ts`'s trigger headers).
      senderAddressFor: async (principal) => {
        const [tenantRow] = await db
          .select({ domain: tenantTable.domain })
          .from(tenantTable)
          .where(eq(tenantTable.id, principal.tenantId))
          .limit(1);
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${principal.tenantId}" to address a mailbox sender from`);
        }
        return `${principal.principalId}@${tenantRow.domain}`;
      },
      // This package only builds the RFC 5322 message and files the
      // caller's own `Sent` copy — actually getting `message.raw` to
      // `message.to` is this hub's job. Every recipient goes through the
      // same `lookups.persistMail` (CL-7449's dual-write wrapper over
      // `createMailboxPersist`) every other outbound frame in this hub
      // already dispatches through: a live run address is delivered by
      // the vendored `baseLookups.persistMail` (`SidecarRouter`-backed
      // session/mail routing, the same path
      // `native-workflow-routine-launch.ts`'s `routeMail` trigger uses),
      // and a human recipient's `principal_mail` copy is appended by the
      // wrapped `createMailboxPersist` alongside it.
      deliver: async (message) => {
        await lookups.persistMail({
          senderAddress: message.from,
          recipients: message.to,
          raw: message.raw,
        });
      },
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  let cronTicker: { start(): void; stop(): void } | undefined;
  {
    // Cron-to-mail bridge (CL-8183): `@corbits/cron` registers its own
    // absolute `/api/tenants/:tenantId/cron` routes, so it gets its own
    // `Hono<TenantEnv>` routed at "/" — matching `mailboxApp` above —
    // rather than `TENANT_PREFIX`, which would double the tenant-route
    // prefix. `requireTenantMember` reads the tenant middleware's context
    // exactly like the mailbox mount's `resolvePrincipal` above.
    const cronApp = new Hono<TenantEnv>();
    mountCron(cronApp, {
      db,
      requireTenantMember: (ctx, tenantId) => {
        const c = ctx as { get(key: "tenant"): { id: string } };
        return c.get("tenant").id === tenantId;
      },
    });
    app.route("/", cronApp);

    // The ticker delivers each due schedule as mail through the same
    // `lookups.persistMail` every other outbound frame in this hub already
    // dispatches through (see the mailbox mount's own `deliver` above).
    // `@corbits/cron` hands back only `{to, subject, body, from}`, not a
    // raw frame, so this hub builds the RFC 5322 message itself with
    // `@corbits/mailbox`'s own `buildMailFrame` — the same builder that
    // package uses for every frame it authors. `senderAddressFor` addresses
    // the sender as `cron@<tenant domain>`, the same domain-scoped shape
    // every other mailbox writer in this file uses (see the mailbox
    // mount's `senderAddressFor` above), by looking the domain up per
    // tenant the way that one does.
    cronTicker = createCronTicker({
      db,
      intervalMs: 60_000,
      senderAddressFor: (tenantId) => `cron@${tenantId}`,
      deliver: async (message) => {
        // `message.from` is `cron@<tenantId>` from `senderAddressFor`
        // above; resolve the real tenant domain to address it from.
        const tenantId = message.from.slice("cron@".length);
        const [tenantRow] = await db
          .select({ domain: tenantTable.domain })
          .from(tenantTable)
          .where(eq(tenantTable.id, tenantId))
          .limit(1);
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${tenantId}" to address cron mail from`);
        }
        const from = `cron@${tenantRow.domain}`;
        await lookups.persistMail({
          senderAddress: from,
          recipients: message.to,
          raw: buildMailFrame({
            from,
            to: message.to.join(", "),
            subject: message.subject,
            body: message.body,
            messageId: generateMailboxMessageId(from),
          }),
        });
      },
    });
    cronTicker.start();
  }

  {
    // Firm memory (CL-8186): `@corbits/memory` registers its own
    // absolute `/api/tenants/:tenantId/memory/*` routes on whatever
    // Hono app it's given (see its `routes/add.ts`, etc.) rather than
    // composing under a mount prefix, so it gets its own `Hono<TenantEnv>`
    // — matching `mailboxApp` above — routed at "/" rather than
    // `TENANT_PREFIX`, which would double the tenant-route prefix.
    // Guarded by the hub's own `requireGrant`: the same
    // `grantStore`/`grantConditionRegistry` every other tenant-scoped
    // mount above uses. `loadMemoryConfig` reads
    // `DATABASE_URL`/`EMBED_BASE_URL`/`EMBED_MODEL` (and friends) from
    // env itself; nothing else in this file constructs the memory plane.
    const memoryApp = new Hono<TenantEnv>();
    createMemory({
      app: memoryApp,
      config: loadMemoryConfig(),
      grantStore: grantStore,
      conditionRegistry: grantConditionRegistry,
    });
    app.route("/", memoryApp);
  }

  // Agent-authored workflows (CL-7360): an agent publishes a workflow
  // codebase as a native `kind:"workflow"` asset through this
  // workflow-run-authenticated surface, then deploys it through stock
  // `POST /api/tenants/:tenantId/workflows/deployments` with the same run
  // bearer. What is left mounted here is the git half alone — reading and
  // writing the asset repo's trees — which no run-bearer credential can do
  // against stock git smart-HTTP today (CL-8171). Unlike
  // `/api/workflow-skills` above, every write here runs a real
  // `grantStore` authorization check (`asset:*`/create,
  // `asset:<id>`/write, `workflow:*`/create) before reaching `RepoStore`,
  // because authoring source is a side effect, not a markdown skill edit.
  app.route(
    "/api/workflow-workflow-authoring",
    createWorkflowAuthorRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: createWorkflowAuthorRegistry({
        db,
        assetService,
        repoStore: agentRepoStore.repoStore,
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
    }),
  );

  // Webhook triggers: tenant-scoped management (create/list/rotate/
  // enable/disable/delete) mounts under the tenant prefix like chat,
  // so it inherits session + tenant-membership resolution and grant
  // checks for free. The ingress endpoint that actually receives an
  // external delivery (`POST /api/webhooks/:triggerId`) is mounted
  // separately below, OUTSIDE the tenant prefix — a webhook sender
  // carries no session cookie and is never a tenant member, so it
  // must never pass through `resolveTenant`. Its own tenant scoping
  // comes from the trigger row the id resolves to, and the only trust
  // it is granted comes from the HMAC signature check in
  // `createWebhookIngressRoutes` itself.
  const webhookTriggerStore = createDrizzleWebhookTriggerStore(db, credentialCipher);
  app.route(
    `${TENANT_PREFIX}/webhook-triggers`,
    createWebhookTriggerRoutes({
      store: webhookTriggerStore,
      requireGrant: createRequireGrant({
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
      workflowDefinitionInTenant: async (tenantId, definitionId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
          columns: { id: true },
        });
        return row !== undefined;
      },
    }),
  );
  app.route(
    "/api/webhooks",
    createWebhookIngressRoutes({
      store: webhookTriggerStore,
      launch: (trigger, payload) =>
        launchWebhookTrigger(
          {
            db,
            sidecarRouter,
            repoStore: agentRepoStore.repoStore,
            workflowAllocationService,
            credentialCipher,
            eventCollectors,
            isRoutable: isSidecarRoutable,
            cryptoProviderCache: cryptoProviders,
          },
          trigger,
          payload,
        ),
    }),
  );
  // Connections: the settings surface's tenant-scoped credential
  // test-and-store, mounted under the same tenant prefix and reusing
  // the same grant store/condition registry every other credential-
  // adjacent extension route does.
  app.route(
    `${TENANT_PREFIX}/connections`,
    createConnectionRoutes({
      hubUrl: config.baseUrl,
      registry: CONNECTOR_REGISTRY,
      requireGrant: createRequireGrant({
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      // Same env bag the OAuth connect flow itself reads below, so
      // `GET .../oauth-configured` reports exactly what a Connect click
      // would decide.
      oauthEnv: {
        huggingfaceClientId: config.huggingfaceOAuthClientId,
        githubAppClientId: config.githubAppClientId,
        githubAppClientSecret: config.githubAppClientSecret,
        gmailClientId: config.gmailClientId,
        gmailClientSecret: config.gmailClientSecret,
      },
      providerHealth: providerHealthStore,
      // CL-6403: an operator-set GITHUB_API_BASE_URL lets a fake server
      // stand in for api.github.com for the `github` connector's PAT
      // probe and stored provider origin; unset in every real deployment,
      // so `probeBaseUrls` is empty and every connector probes its own
      // fixed production origin.
      probeBaseUrls:
        config.githubApiBaseUrl !== undefined ? { github: config.githubApiBaseUrl } : {},
    }),
  );
  // Connections' own OAuth connect flow (CL-6389): `createOAuthConnectRoutes`
  // (`@corbits/connections`) was exported but never mounted here — every
  // provider whose descriptor sets `oauth` (OpenRouter, Hugging Face, and
  // the GitHub App path) needs this to complete a one-click connect from
  // the settings surface above. Follows #115's `mcp-servers/oauth` mount
  // just below: state-param CSRF (real `state()` + exact-match callback
  // validation) lives entirely inside the factory; this mount only wires
  // the tenant already resolved by the platform's tenant middleware
  // through to `createTenantConnectCredential`.
  app.route(
    `${TENANT_PREFIX}/connections/oauth`,
    createOAuthConnectRoutes<TenantEnv>({
      hubUrl: config.baseUrl,
      log: (line) => log.info`${line}`,
      credentialCipher,
      registry: CONNECTOR_REGISTRY,
      // Same env bag `GET .../connections/oauth-configured` reads above.
      oauthEnv: {
        huggingfaceClientId: config.huggingfaceOAuthClientId,
        githubAppClientId: config.githubAppClientId,
        githubAppClientSecret: config.githubAppClientSecret,
        gmailClientId: config.gmailClientId,
        gmailClientSecret: config.gmailClientSecret,
      },
      connectCredential: createTenantConnectCredential({
        hubUrl: config.baseUrl,
        log: (line) => log.info`${line}`,
        registry: CONNECTOR_REGISTRY,
        providerHealth: providerHealthStore,
      }),
      defaultReturnPath: "/settings/connections",
      // `/w/` is the chat room prefix: the in-room connect card
      // (CL-6393) starts OAuth from a room and must land back in it.
      returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins", "/w/"],
    }),
  );
  // Loopback OAuth connect (CL-7508): codex/xai-oauth connect through a
  // sidecar-hosted pinned-port login, not a hub redirect. The gate (a local
  // sidecar) lives on the router; this mount only ships the authorize URL
  // back to the caller and lets the sidecar's terminal result frame persist
  // through the shared connect sequence.
  app.route(
    `${TENANT_PREFIX}/connections/oauth`,
    createOAuthLoopbackRoutes({
      hubUrl: config.baseUrl,
      log: (line) => log.info`${line}`,
      registry: CONNECTOR_REGISTRY,
      requestOAuthLogin: (args) => sidecarRouter.requestOAuthLogin(args),
      providerHealth: providerHealthStore,
    }),
  );
  // MCP servers: the tenant-scoped connect/list/disconnect surface
  // Plugins drives (CL-6142), mirroring `connections` above but for
  // tenant-minted `mcp:<slug>` connectors rather than
  // `CONNECTOR_REGISTRY`'s fixed set.
  app.route(
    `${TENANT_PREFIX}/mcp-servers`,
    createMcpServerRoutes({
      hubUrl: config.baseUrl,
      requireGrant: createRequireGrant({
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      presets: MCP_PRESETS,
    }),
  );
  // MCP servers' OAuth connect flow (CL-6152): discovers and drives a
  // preset's (or an ad hoc `?url=&name=`) authorization server per the
  // MCP spec, landing back on the same `mcp:<slug>` credential storage
  // `createMcpServerRoutes` above uses for a pasted token.
  app.route(
    `${TENANT_PREFIX}/mcp-servers/oauth`,
    createMcpOAuthRoutes({
      hubUrl: config.baseUrl,
      requireGrant: createRequireGrant({
        grantStore: grantStore,
        conditionRegistry: grantConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      credentialCipher,
      presets: MCP_PRESETS,
      // `/w/` for the same reason as the connections/oauth mount above.
      returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins", "/w/"],
    }),
  );
  // Myra's own connections-visibility surface
  // (`@corbits/connections-tools`' `list_connections`/
  // `request_connection`): the workflow-run-authenticated counterpart
  // to the tenant-session mount just above.
  app.route(
    "/api/workflow-connections",
    createWorkflowConnectionRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      listMcpServers: (tenantId) => listMcpServerConnections(db, tenantId),
    }),
  );
  // Notify-to-reconnect for an OAuth-connected credential whose token
  // expired (Hugging Face today — see docs/onboarding-huggingface-connect.md)
  // is now `workflows/credential-expiry` (CL-8181), a schedule-triggered
  // workflow deployed like any other Routine rather than a hub-owned
  // periodic loop.

  // Snooze is dropped (CL-8185): the unsnooze sweep and its `inbox.snooze`
  // table are gone — see `packages/inbox/src/migrations.ts`'s forward-drop.

  // CL-8206: the hub-computed cron auto-fire over a definition's frozen
  // wire projection is gone — Interchange 79adc433 retired the
  // projection storage `listDeployedCronDefinitions` read the cron
  // trigger off of, with no replacement column. Per CL-8181's own
  // direction (see the notify-to-reconnect comment above), a
  // schedule-triggered routine is deployed like any other workflow now
  // rather than driven by a hub-owned periodic loop; this hard cutover
  // has no port to a stock equivalent.

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));

  // CL-8185: the hub-sweep's less-is-more ruling deleted the tenant-subtree
  // bearer widening (`workflow-run-tenant-auth.ts`'s `withWorkflowRunTenantAuth`)
  // and the in-flight request tracker (`in-flight-requests.ts`). Stock
  // `@intx/hub-api` still authenticates a run bearer on the single
  // `/workflows/deployments` mount via `workflowRunAuthenticator` above; a
  // run agent reaching any other tenant route now needs a session like
  // everything else. See "Upstream asks" for both gaps.
  return {
    app,
    whenRequestsIdle: () => Promise.resolve(),
    db,
    close: async () => {
      sidecarAllocationReconciliationStopped = true;
      if (sidecarAllocationReconciliationTimer !== undefined) {
        clearTimeout(sidecarAllocationReconciliationTimer);
      }
      await closeMailbox();
      cronTicker?.stop();
      // The pool end waits on in-flight queries; a query whose socket
      // died with the process must never stall shutdown, so bound it.
      // (CL-7584: a fire-and-forget reconcile's request can be cut
      // mid-query by this very teardown.)
      await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
  };
}

if (import.meta.main) {
  await setup();
  const config = readHubConfig(process.env);
  mkdirSync(config.hubDataDir, { recursive: true });
  const hub = await createHub(config);
  const url = new URL(config.baseUrl);
  const port =
    config.listenPort ??
    (url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port));
  const server = Bun.serve({
    fetch: hub.app.fetch,
    websocket,
    port,
    idleTimeout: 0,
  });
  const log = getLogger(["hub"]);
  log.info`Hub serving on port ${port}`;
  // CL-8185: the bounded-drain shutdown (`shutdown.ts`) and its in-flight
  // tracker were deleted under the hub-sweep's less-is-more ruling. A
  // signal now force-stops the listener and closes hub resources directly,
  // with no drain window for an in-flight request and no reported cause on
  // a hang. See "Upstream asks".
  const shutdown = () =>
    void (async () => {
      try {
        server.stop(true);
        await hub.close();
      } finally {
        process.exit(0);
      }
    })();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
