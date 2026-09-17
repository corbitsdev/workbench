// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createApprovalStore,
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createSidecarAllocationStore,
  createSignalCorrelationStore,
  createWorkflowRunDispatchStore,
  listAssetsForTenant,
  listVisibleOfferings,
  resolveCredentialRequirement,
} from "@intx/db";
import {
  asset as assetTable,
  modelPricing,
  tenant as tenantTable,
  user as userTable,
  workflowDefinition,
} from "@intx/db/schema";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
} from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import type { CredentialCipher } from "@intx/types";
import {
  createApp,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  readDurableWorkflowRunLifecycles,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";
import { WorkflowDefinitionInvalidError } from "@intx/workflow-deploy";
// CL-7362: computes the preview's wire hash from the probed-but-unapproved
// projection `installAndApproveWorkflowSource` returns on `grants_not_approved`
// — the gate itself only stamps this hash on the `ok:true` arm.

import { isPlannerCreatedDefinitionName } from "@corbits/agent-directory";

import {
  DEFAULT_TURN_CLAIM_TTL_MS,
  createArtifactDeliveryHandler,
  createDrizzleAgentTurnStore,
  createInMemoryTurnClaimStore,
  createWorkbenchHostInferencePreferencesResolver,
  createWorkbenchSubscriberRegistry,
  createWorkbenchTurnQueue,
  createTurnCancelRegistry,
  createChatOrchestrator,
  createChatRoutes,
  createDrizzleBlockResponseStore,
  createDrizzleChatStore,
  createDrizzleClientIdStore,
  createDrizzleNativePrincipalStore,
  createDrizzlePinStore,
  createDrizzleReactionStore,
  createDrizzleRoomMessageStore,
  createDrizzleThreadStore,
  createDrizzleTurnMailCorrelationStore,
  createDrizzleWriteClaimStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  createRelaunchNoticePoster,
  createRunTriggerClient,
  createWorkflowParticipantRoutes,
  isWorkbenchHostDefinitionName,
  listConnectedProviders,
  listDefaultInferencePreferences,
  recordSourcesDigest,
  startWorkflowCommand,
  settleConnectedService,
  workbenchLaunchPersistExtra,
  createCryptoProviderCache,
  tagCredentialCipher,
  verifyInternalRunTriggerToken,
} from "@corbits/chat";
import {
  createDrizzleMailboxWriter,
  type MailboxFanoutDeps,
} from "@corbits/chat/mailbox-fanout";
import type { RelaunchNoticePort } from "@corbits/chat";
import { reportError } from "@corbits/error-sink";
import type { FinalizedTurnToolCall } from "@corbits/turn-artifacts";
import { decodedOrNull } from "@corbits/url-path";
import {
  createInboxRoutes,
  WORKBENCH_MAILBOX_VOCABULARY,
} from "@corbits/inbox";
import {
  applyInsightsMigrations,
  createDrizzleRunTraceReader,
  createDrizzleTurnTextSnapshotReader,
  createInsightsRoutes,
  createPostgresTurnLatencyStore,
  createPostgresUsageStore,
  createTurnLatencyTracker,
  createUsageSink,
  withTurnPartPersistGuard,
} from "@corbits/insights";
import {
  applyPreferencesMigrations,
  createPostgresPreferencesStore,
  createPreferencesRoutes,
} from "@corbits/preferences";
import {
  applyBenchMigrations,
  createBenchRoutes,
  createPostgresBenchSettingsStore,
} from "@corbits/bench";
import {
  applyEvalsMigrations,
  createEvalRunRoutes,
  createPostgresEvalRunStore,
} from "@corbits/evals";
import {
  applyInferenceCatalogMigrations,
  createBenchModelPolicyRoutes,
  createPostgresBenchModelPolicyStore,
  createResolvedOfferingsRoutes,
  createWorkflowCatalogRoutes,
} from "@corbits/inference-catalog";
import { createWorkflowAccessRoutes } from "@corbits/access-tools/routes";
import { generateId } from "@intx/hub-common";

import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  mountMailbox,
} from "@corbits/mailbox";
import {
  createHubMailboxAuthorizeSender,
  createHubMailboxResolveRefs,
  createHubPersistMailWithSessionEnsure,
} from "./mailbox-persist";
import {
  createCommandRegistry,
  createCommandRoutes,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import {
  createDrizzleWebhookTriggerStore,
  createWebhookIngressRoutes,
  createWebhookTriggerRoutes,
  launchWebhookTrigger,
} from "@corbits/webhook-triggers";
import { createTemplateBlockRoutes } from "./templates/template-block-routes";
import {
  createWorkflowDetailRoute,
  createScheduledWorkflowRoutes,
  renderWorkflowSourceTree,
  WORKFLOW_SOURCE_ENTRY,
  ensureRunSession,
  recordAgentSessionAtProvision,
  isConversationalWorkflowName,
} from "@corbits/workflows";
import {
  createSidecarProvisioner as createE2BSidecarProvisioner,
  readProvisionerConfig as readE2BProvisionerConfig,
} from "@corbits/e2b-sandbox-sidecar";
import {
  createDrizzleRunKeyHistoryStore,
  createRunKeyHistoryListener,
  createRunKeyHistoryRoutes,
} from "@corbits/run-key-history";

import {
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
  DEFAULT_ASSET_REF,
  resolveRoutableAddress,
  WorkflowProvisioningError,
  type AgentRepoStore,
  type EventCollectorRegistry,
  type WsHandle,
} from "@intx/hub-sessions";
import { createLaunchCaches } from "./launch-caches";
import { hubErrorHandler } from "./hub-error-handler";
import { wireMailRedelivery } from "./mail-redelivery";
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import {
  createToolAllowanceRegistry,
  withGrantAllowance,
} from "@corbits/approvals";
import {
  createMcpCallClassifier,
  MCP_CALL_TOOL,
  mcpTools,
} from "@corbits/mcp-tools";
import {
  createAllowanceAutoApprover,
  createMcpServerToolsAllowanceLoader,
  createRegisteredApprovalFinder,
  createTenantGrantLister,
} from "./grant-allowance";
import { createDockerSidecarProvisioner } from "@corbits/docker-provisioner";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
  type ProcessProvisionerRole,
} from "@corbits/process-provisioner";
import { createWorkflowRunAuthenticator } from "@corbits/artifacts-hub";
import {
  createPresenceRoomRegistry,
  createPresenceRoutes,
} from "@corbits/presence";
import {
  createConnectionRoutes,
  isInferenceProvider,
  createMcpOAuthRoutes,
  createMcpServerRoutes,
  createOAuthConnectRoutes,
  createOAuthLoopbackRoutes,
  createTenantConnectCredential,
  createWorkflowConnectionRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  listMcpServerConnections,
} from "@corbits/connections";
import type { ServiceConnectedHook } from "@corbits/connections";
import { CONNECTOR_REGISTRY, MCP_PRESETS } from "./native-connector-registry";
import {
  createProviderHealthPort,
  createProviderHealthStore,
} from "@corbits/connections/provider-health";
import { createHubNotifyDeliveryDeps } from "./notify-delivery";
import {
  createWorkflowAuthorRegistry,
  createWorkflowAuthorRoutes,
  WorkflowAuthorError,
  type WorkflowDeployer,
} from "@corbits/workflows";
import {
  createCredentialExpirySweep,
  createDrizzleCredentialExpirySweepStore,
} from "./credential-expiry-sweep";
import {
  createDrizzleServingRefreshStore,
  createTenantServingRefresh,
} from "./credential-material-refresh";
import {
  createDrizzleInboxUnsnoozeSweepStore,
  createInboxUnsnoozeSweep,
} from "./inbox-unsnooze-sweep";

import { type } from "arktype";
import { betterAuth } from "better-auth";
import { createSignInAttemptLimiter } from "./sign-in-rate-limit";
import { createSetupStatusRoutes } from "./setup-status";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, Hono, type Next } from "hono";

import { upgradeWebSocket, websocket } from "hono/bun";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";
import {
  readHubConfig,
  type HubConfig,
  type SidecarProvisionerConfig,
} from "./config";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import { withTurnPartWriteDefaults } from "./turn-part-content-default";
import { createBootAssetWiring, REGISTRIES } from "./asset-service-factory";
import {
  claimScheduleMinuteFromDb,
  createWorkflowScheduler,
  launchScheduledDefinitionFromDb,
  listScheduledDefinitionsFromDb,
  runNowScheduledDefinition,
} from "./workflow-scheduler";
import { createToolGrantsForPins } from "./tool-grants";
import { drainHubServer, shutdownHub } from "./shutdown";
import {
  createInFlightRequestTracker,
  withInFlightRequestTracking,
} from "./in-flight-requests";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
// In-repo tool packages (`packages/granola-tools`, `packages/linear-tools`,
// `packages/skills-tools`) are unpublished to npm and stay that way:
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
const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const SignInEmailBody = type({ email: "string" });
// Chat residents carry a real hub-driven idle-reap again (reversing
// CL-5477's removal): the sidecar's own park/wake scheme it was meant to
// replace has itself been retired in favor of a simpler reap-and-relaunch
// model. `createHubChatPlatform`'s `lifecycle` binding below tags every
// idle eviction with `@corbits/agent-lifecycle`'s
// `IDLE_HIBERNATE_UNDEPLOY_REASON`, which the sidecar's `agent.undeploy`
// handler matches to choose the state-preserving teardown flavor
// (`reclaimDirs: false` — deployment record, step-state, and slug all
// survive) rather than the destructive default a caller-initiated
// undeploy gets. That is what makes this safe to re-enable where the old
// bare `"idle"`-tagged undeploy this ticket's `CHAT_IDLE_SLEEP_MS`
// emergency bump (8ca85543) band-aided around was genuinely lossy: a
// later `wakeByAddress` relaunch resumes the same run rather than
// starting a fresh one.

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
  return createEnvKeyCredentialCipher(
    Buffer.from(config.credentialEncryptionKeyHex, "hex"),
  );
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
    cipher: createEnvKeyCredentialCipher(
      Buffer.from(config.principalKeyEncryptionKeyHex, "hex"),
    ),
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
  return tagCredentialCipher(credentialCipherFrom(config, log));
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
            role === "probe"
              ? "process-provisioner-probe"
              : "process-provisioner",
          ),
          hubWebSocketUrl,
        }),
      });
    case "docker":
      return createDockerSidecarProvisioner({
        config: {
          image: config.image,
          stateFilePath: path.resolve(
            hubDataDir,
            "docker-provisioner",
            "state.json",
          ),
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
  const { db, close } = createDB(dbConfigFromUrl(config.databaseUrl));
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(
    config.databaseUrl,
  );
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
        // `false` fully disables better-auth's own built-in special rule
        // for /sign-in* (3 attempts / 10 seconds, keyed on the client IP
        // above) rather than leaving it running in parallel as a second,
        // weaker mechanism: that IP key is exactly what CL-6494's
        // private-network bypass defeats, so enforcement for this path
        // lives entirely in `signInAttemptLimiter` below instead.
        [SIGN_IN_EMAIL_PATH]: false,
      },
    },
  });
  // Account-keyed sign-in rate limit (CL-6494) — see `sign-in-rate-limit.ts`
  // for why this replaces better-auth's own IP-keyed sign-in enforcement
  // entirely rather than composing with it.
  const signInAttemptLimiter = createSignInAttemptLimiter(
    config.signInRateLimit.windowSeconds,
    config.signInRateLimit.max,
  );
  const { signingKey, agentRepoStore, assetService } =
    await createBootAssetWiring({
      db,
      dataDir: config.hubDataDir,
      ...(config.allowGitInsideWorkTree === true
        ? { allowGitInsideWorkTree: true }
        : {}),
    });
  const baseLookups = createHubSessionLookups({ db, agentRepoStore });
  // Shared with `createRunKeyHistoryListener` below: one store instance
  // for the process, read here ahead of `workflow_run` and written to
  // there off every `agent.deploy.ack`.
  const runKeyHistoryStore = createDrizzleRunKeyHistoryStore(db);
  // A chat agent is a native provisioned deployment. Reconnect
  // ownership is Interchange's live run + `@corbits/run-key-history`.
  // Completed means dead; wake is a fresh provision, not a folded-run
  // idle settle.
  // CL-6345: the grant-allowance gate wraps `registerSignalCorrelation`
  // so a parked read-only call whose resource a standing grant covers is
  // auto-approved right after its approval row lands — no card for a
  // human, the ledgered row still records the decision. The gate's deps
  // (dispatch service, grant store, approval stores) don't exist yet at
  // this point in the composition, so the wrapper reads through this ref,
  // assigned once they do; until then every registration takes the plain
  // parked path.
  const grantAllowanceGateRef: {
    current?: (
      args: Parameters<typeof baseLookups.registerSignalCorrelation>[0],
    ) => Promise<void>;
  } = {};
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
  // Hoisted ahead of their other uses below (chat routes, the room
  // timeline store at CL-6327) so `createHubMailboxResolveRefs`
  // can share these two instances rather than constructing its own just
  // for the mailbox wiring.
  const chatStore = createDrizzleChatStore(db);
  const roomMessages = createDrizzleRoomMessageStore(db);
  const lookups = {
    ...baseLookups,
    materializeMailTriggeredRunGrants: mailTriggeredRunGrants,
    // CL-7449: every outbound agent frame also lands a durable
    // `principal_mail` row in each addressed human participant's mailbox,
    // dual-written alongside `baseLookups.persistMail`'s `session_mail`
    // write. Dual-write independence is `createMailboxPersist`'s own
    // contract (upstream failing still attempts the mailbox write, and a
    // mailbox failure never fails upstream) -- no second try/catch belongs
    // here. `resolveRefs` runs inside the package's own transaction, so the
    // workbench ref is present before the post-commit bus event fires --
    // no out-of-band UPDATE, no polling read.
    persistMail: createMailboxPersist(mailboxDb, {
      upstream: createHubPersistMailWithSessionEnsure(
        db,
        eventCollectorsRef,
        baseLookups.persistMail,
      ),
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
      resolveRefs: createHubMailboxResolveRefs(chatStore, roomMessages),
    }),
    async registerSignalCorrelation(
      args: Parameters<typeof baseLookups.registerSignalCorrelation>[0],
    ): Promise<void> {
      const gate = grantAllowanceGateRef.current;
      if (gate !== undefined) return gate(args);
      return baseLookups.registerSignalCorrelation(args);
    },
  };
  const hubPublicKey = hexEncode(signingKey.publicKey);
  // Same owning check GET /connections uses — see
  // `@corbits/connections`' `workflow-connection-routes.ts` and the
  // `createWorkflowConnectionRoutes` wiring below. Not
  // `listConnectedProviders` (catalog-only).
  const isConnectorConnected = async (tenantId: string, connectorId: string) =>
    (await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName: connectorId, source: "tenant" },
      null,
      null,
    )) !== null;
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
          where: (allocation, { eq: equals }) =>
            equals(allocation.id, identity.allocationId),
          columns: { provisionerId: true },
        });
        return allocation?.provisionerId === "process";
      },
    },
  });
  const isSidecarRoutable = (address: string) =>
    sidecarRouter.getRoutableAddresses().includes(address);
  // A finalized turn's persisted-artifact tool-call results become
  // delivery file parts (CL-6000) via `createArtifactDeliveryHandler`,
  // built once `chatStore`/`chatPlatform` exist further down this
  // composition. `onTurnFinalized` itself must be supplied at
  // `createEventCollectorRegistry` construction time, before those
  // deps exist, so this indirection ref is set once they do and every
  // call before that point is a harmless no-op.
  // Process-lifetime provider-health signal (CL-6092): the one store
  // both the chat orchestrator's classified-failure port and
  // `GET .../connections/provider-health` read/write, so a runtime
  // failure a turn just reported is visible to the shell banner on its
  // very next poll. In-memory by design — see `provider-health.ts`'s own
  // header for why this never needs to survive a restart.
  const providerHealthStore = createProviderHealthStore();
  const artifactDeliveryHandlerRef: {
    current?: (
      agentAddress: string,
      turn: {
        turnId: string;
        toolCalls: FinalizedTurnToolCall[];
        errors: readonly { category: string; message: string }[];
      },
    ) => void;
  } = {};
  // Package-owned insights tables, migrated ahead of the event collector
  // registry so `usageSink` is live before the first `inference.usage`
  // event can arrive.
  await applyInsightsMigrations(config.databaseUrl);
  const insightsUsage = createPostgresUsageStore(config.databaseUrl);
  const insightsLatency = createPostgresTurnLatencyStore(config.databaseUrl);
  const usageSink = createUsageSink({
    store: insightsUsage.store,
    generateId: () => generateId("inferenceTurn"),
  });
  // CL-6257: per-message-run stage latency (message-received →
  // reactor.start → inference.start → first-token → reply-posted). The
  // vendored event collector never persists the events this reads (see
  // @corbits/insights' latency-tracker.ts header) and isn't ours to edit,
  // so this observes the same InferenceEvent stream from outside it by
  // wrapping `eventCollectors` below — the same seam `withTurnPartPersistGuard`
  // already uses on the `db` handle passed into the vendored registry.
  const turnLatency = createTurnLatencyTracker({
    store: insightsLatency.store,
    generateId: () => generateId("inferenceTurn"),
  });
  const baseEventCollectors = createEventCollectorRegistry({
    // `withTurnPartPersistGuard` (see @corbits/insights) wraps
    // `withTurnPartWriteDefaults`: it retries a turn_part insert once on
    // the collector's known turn_id/session_id FK race and makes any
    // surviving loss loud (error-level cause, counted) instead of a
    // swallowed WRN.
    db: withTurnPartPersistGuard(withTurnPartWriteDefaults(db)),
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
    onTurnFinalized: (agentAddress, turn) => {
      artifactDeliveryHandlerRef.current?.(agentAddress, turn);
    },
    // Per-turn usage, emitted once when the collector finalizes a turn.
    onUsage: (_agentAddress, usage) => {
      void usageSink
        .handle({
          turnId: usage.turnId,
          tenantId: usage.tenantId,
          sessionId: usage.sessionId,
          provider: usage.provider,
          model: usage.model,
          tokens: usage.usage,
        })
        .catch((err: unknown) => {
          log.warn`Failed to record usage for turn ${usage.turnId}: ${err instanceof Error ? err.message : String(err)}`;
        });
    },
  });
  // Wraps every `EventCollectorRegistry` call the vendored session
  // orchestrator makes: `create`/`dispatch`/`abandon` also feed
  // `turnLatency`, which is the only place tenantId/sessionId land
  // against an agentAddress for the raw event stream (the registry keeps
  // that mapping private). Every other method passes straight through.
  const eventCollectors: EventCollectorRegistry = {
    ...baseEventCollectors,
    create(agentAddress, tenantId, sessionId, runId) {
      turnLatency.onSessionCreate(agentAddress, tenantId, sessionId);
      baseEventCollectors.create(agentAddress, tenantId, sessionId, runId);
    },
    dispatch(agentAddress, event) {
      // CL-7480: a run's turn events can start arriving before anything
      // else ever recorded its session — the first inbound trigger that
      // just reconciled its principal races this same dispatch. No live
      // collector for the address is exactly that case: ensure the
      // session (and, inside it, the collector) before delegating,
      // rather than silently dropping the event for a collector that
      // never gets created.
      if (!baseEventCollectors.has(agentAddress)) {
        void ensureCollectorThenDispatch(agentAddress, event);
        return;
      }
      turnLatency.onEvent(agentAddress, event);
      baseEventCollectors.dispatch(agentAddress, event);
      // Mirrors the registry's own `isTerminal` check (event-collector-registry.ts)
      // so `turnLatency`'s per-agentAddress session map is cleared on the
      // same terminal events that make the registry drop its own collector
      // — otherwise a session that ends without `abandon()` never frees.
      const isTerminal =
        event.type === "reactor.done" ||
        (event.type === "reactor.error" && event.data.fatal);
      if (isTerminal) turnLatency.onSessionEnd(agentAddress);
    },
    abandon(agentAddress) {
      turnLatency.onSessionEnd(agentAddress);
      baseEventCollectors.abandon(agentAddress);
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
    turnLatency.onEvent(agentAddress, event);
    baseEventCollectors.dispatch(agentAddress, event);
    const isTerminal =
      event.type === "reactor.done" ||
      (event.type === "reactor.error" && event.data.fatal);
    if (isTerminal) turnLatency.onSessionEnd(agentAddress);
  }
  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
  });
  // A second, independent listener on the same `agent.deploy.ack` event
  // `createHubSessionOrchestrator` already reacts to above: that vendor
  // listener owns `workflow_run.public_key`'s live value, this one
  // maintains a decoupled append-only history so a historical signature
  // stays re-provable after a key rotation. It never reads
  // `workflow_run` — only its own last-recorded entry per address — so
  // it cannot race vendor's independent write to that row on the same
  // event.
  createRunKeyHistoryListener({
    events: sidecarRouter.events,
    store: runKeyHistoryStore,
  });
  // CL-6225: the launch path re-reads every tool-package tarball and
  // rebuilds a full git pack of every attached asset on every agent
  // launch; both reads are pure functions of an immutable commit SHA (see
  // `./launch-caches.ts`). Only `createSessionService`'s launch path gets
  // the cached wrapper — the smart-HTTP git routes and the asset REST
  // routes below keep the raw `agentRepoStore`/`assetService` because they
  // serve requests under per-request principals the cache is not sound
  // for (see `./launch-caches.ts`'s header comment).
  const launchCaches = createLaunchCaches({
    assetService,
    repoStore: agentRepoStore.repoStore,
  });
  // CL-6149: a launch's pinned tool packages (`toolPackagePins`) carry
  // no grants of their own — the deploy-time capability walk
  // (`vendor/intx/workflow-deploy/src/capability-walk.ts`) only derives
  // `tool:` grants for inline tool factories. `toolGrantsForPins` — the
  // port `createHubChatPlatform`'s `CreateHubChatPlatformDeps` is built
  // with — turns a launch's pins into `tool:<qualifiedId>` grants read
  // from the tenant-resolved `corbits-tools` asset's packed manifests
  // (CL-7582), through the same cached launch-path read seam above.
  const toolGrantsForPins = createToolGrantsForPins({
    listAssets: (tenantId, kind) => listAssetsForTenant(db, tenantId, kind),
    assetService: launchCaches.assetService,
  });
  const launchAgentRepoStore: AgentRepoStore = {
    writeDeployTree: agentRepoStore.writeDeployTree,
    createDeployPack: agentRepoStore.createDeployPack,
    receiveAgentStatePack: agentRepoStore.receiveAgentStatePack,
    receiveWorkflowRunPack: agentRepoStore.receiveWorkflowRunPack,
    getSigningPublicKey: agentRepoStore.getSigningPublicKey,
    repoStore: launchCaches.repoStore,
  };
  // Shared-capacity `deployWorkflowFromSource` / `deployAdoptedWorkflowFromSource`
  // are gone on this pin. The provisioned path persists its source in
  // `workflow_run_launch_spec`; there is nothing left for a session-service
  // wrapper to record.
  const sessionService = createSessionService({
    sidecarRouter,
    sidecarAllocationRouter: sidecarRouter,
    agentRepoStore: launchAgentRepoStore,
    assetService: launchCaches.assetService,
    db,
    toolPackageRegistries: {
      httpRegistries: REGISTRIES,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@corbits", registry: CORBITS_TOOLS_REGISTRY }],
    },
  });
  const hubWebSocketUrl =
    config.sidecarWebSocketUrl ??
    `${config.baseUrl.replace(/^http/, "ws")}/api/sidecars/ws`;
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
        buildSidecarProvisioner(
          provisionerConfig,
          config.hubDataDir,
          hubWebSocketUrl,
          role,
        ),
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
    onReady: async (allocation) => {
      await workflowAllocationService.deployReadyAllocation(allocation);
      await workflowDispatchService.requeueForReadyAllocation(
        allocation.anchorRunId,
      );
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
  sidecarRouter.events.on(
    "mail.inbound.acknowledged",
    ({ messageId, allocated }) => {
      if (allocated === undefined) return;
      return workflowDispatchService.acknowledge({ ...allocated, messageId });
    },
  );
  const sidecarAllocationLog = getLogger(["hub", "sidecar-allocation"]);
  const ALLOCATION_RECONCILIATION_INTERVAL_MS = 1_000;
  const ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS = 30_000;
  let nextAllocationConnectionRepairAt =
    Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
  let sidecarAllocationReconciliationStopped = false;
  let sidecarAllocationReconciliationTimer:
    ReturnType<typeof setTimeout> | undefined;
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
        nextAllocationConnectionRepairAt =
          Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
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
    // `@intx/hub-api`'s `GetSession` is a deliberately pluggable seam
    // (its own doc comment: "so a third-party identity provider can be
    // plugged in"), and this composition root owns it. `@corbits/chat`'s
    // run-trigger client (CL-7490) has no browser cookie to present for
    // most of its calls — mention fan-out, a relaunch resend, the
    // mailbox-fanout persist seam all run with no inbound HTTP request
    // in scope — so it signs a short-lived internal token instead (see
    // `@corbits/chat`'s `run-trigger-internal-auth.ts`) naming the
    // better-auth user it authenticates as. This checks that token
    // FIRST and only falls through to the real cookie-session path when
    // the header is absent; a PRESENT-but-invalid token fails closed
    // (401 via a null session) rather than silently retrying as a
    // session, the same posture `workflow-run-deploy-auth` documents for
    // its own bearer mirror in `vendor/intx/hub-api`.
    getSession: async (headers) => {
      const internalRunTriggerToken = headers.get(
        "x-corbits-internal-run-trigger",
      );
      if (internalRunTriggerToken !== null) {
        const userId = verifyInternalRunTriggerToken(
          config.sessionSecret,
          internalRunTriggerToken,
        );
        if (userId === null) return null;
        const userRow = await db.query.user.findFirst({
          where: eq(userTable.id, userId),
        });
        if (userRow === undefined) return null;
        const now = new Date();
        return {
          user: userRow,
          session: {
            id: `internal_run_trigger_${userRow.id}`,
            createdAt: now,
            updatedAt: now,
            userId: userRow.id,
            expiresAt: new Date(now.getTime() + 30_000),
            token: internalRunTriggerToken,
          },
        };
      }
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: async (c) => {
      // Account-keyed sign-in brute-force protection (CL-6494, hardened
      // CL-6521) — see `sign-in-rate-limit.ts` for why this fully replaces
      // better-auth's own IP-keyed enforcement for this path instead of
      // running beside it, and for why only failures ever consume budget.
      if (c.req.method === "POST" && c.req.path.endsWith(SIGN_IN_EMAIL_PATH)) {
        let email: string | undefined;
        try {
          const body: unknown = await c.req.raw.clone().json();
          const parsed = SignInEmailBody(body);
          if (!(parsed instanceof type.errors)) email = parsed.email;
        } catch {
          email = undefined;
        }
        // A body that doesn't parse to `{ email: string }` never touches
        // the limiter at all — there is no account to key a bucket on,
        // and better-auth will reject the request on its own terms.
        const response = await auth.handler(c.req.raw);
        if (email === undefined) return response;
        if (response.status >= 200 && response.status < 300) {
          signInAttemptLimiter.recordSuccess(email);
          return response;
        }
        const decision = signInAttemptLimiter.recordFailure(email);
        if (!decision.allowed) {
          return c.json(
            {
              error: "rate_limited",
              message: `Too many sign-in attempts. Try again in ${decision.retryAfterSeconds} second${decision.retryAfterSeconds === 1 ? "" : "s"}.`,
            },
            429,
            { "Retry-After": decision.retryAfterSeconds.toString() },
          );
        }
        return response;
      }
      return auth.handler(c.req.raw);
    },
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
          if (typeof evt.data === "string")
            sidecarRouter.handleMessage(handle, evt.data);
        },
        onClose: () => sidecarRouter.handleClose(handle),
      };
    }),
  });

  // Without this, any exception escaping a route (extension or platform
  // alike) falls through to Hono's built-in handler: a bare 500 with
  // nothing reported. See `hubErrorHandler`'s own doc comment.
  app.onError(hubErrorHandler());

  // Presence rooms are ephemeral and process-local by design.
  const presenceRoomRegistry = createPresenceRoomRegistry();

  // Chat's own grant store/condition registry, built the same way
  // `createApp` builds its default when none is supplied (see
  // `@intx/hub-api`'s `mountHubRoutes`): a db-backed grant store and
  // the time-window condition evaluator. `createRequireGrant` is the
  // published construction the platform's own internal instance is
  // not exported for.
  const chatGrantStore = createGrantStore(db);
  const chatConditionRegistry: ConditionRegistry = {
    time_window: timeWindowEvaluator,
  };
  // CL-6345: arm the grant-allowance gate declared up at `lookups`. The
  // one annotation today is `mcp_call` (registered under both its bare
  // and pinned-namespaced names): a downstream MCP tool the server
  // itself marks `readOnlyHint: true`, called on a connection whose
  // `mcp:<slug>` resource an `allow`/"read" grant covers, is
  // auto-approved through the native resolve machinery; every other
  // parked call — writes, unverified claims, uncovered connections —
  // waits for a human exactly as before.
  {
    const mcpCallClassify = createMcpCallClassifier(
      createMcpServerToolsAllowanceLoader({ db, credentialCipher }),
    );
    const allowanceLog = (line: string) => log.info`${line}`;
    grantAllowanceGateRef.current = withGrantAllowance(
      (args) => baseLookups.registerSignalCorrelation(args),
      {
        registry: createToolAllowanceRegistry([
          {
            tool: MCP_CALL_TOOL,
            grantAction: "read",
            classify: mcpCallClassify,
          },
          {
            tool: `${mcpTools.id}:${MCP_CALL_TOOL}`,
            grantAction: "read",
            classify: mcpCallClassify,
          },
        ]),
        findRegisteredApproval: createRegisteredApprovalFinder(db),
        listTenantGrants: createTenantGrantLister(db),
        autoApprove: createAllowanceAutoApprover(
          {
            db,
            sidecarRouter,
            workflowDispatchService,
            readRunLifecycles: async (
              agentAddress,
              topLevelRunId,
              targetRunId,
            ) => {
              const lifecycles = await readDurableWorkflowRunLifecycles(
                agentRepoStore.repoStore,
                agentAddress,
                [topLevelRunId, targetRunId],
              );
              return {
                topLevel: lifecycles.get(topLevelRunId) ?? "absent",
                target: lifecycles.get(targetRunId) ?? "absent",
              };
            },
            grantStore: chatGrantStore,
            conditionRegistry: chatConditionRegistry,
            approvalStore: createApprovalStore(db),
            signalCorrelationStore: createSignalCorrelationStore(db),
          },
          allowanceLog,
        ),
        log: allowanceLog,
      },
    );
  }
  app.route(
    `${TENANT_PREFIX}/presence`,
    createPresenceRoutes({
      registry: presenceRoomRegistry,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  const threadStore = createDrizzleThreadStore(db);
  const blockResponseStore = createDrizzleBlockResponseStore(db);
  const reactionStore = createDrizzleReactionStore(db);
  const pinStore = createDrizzlePinStore(db);
  // Durable redelivery-dedup for the finalized-turn write surfaces
  // (CL-6039) — see `WriteClaimStore`'s own doc comment. Same `db`
  // handle as every other Drizzle store above, never a second
  // connection.
  const writeClaims = createDrizzleWriteClaimStore(db);
  // Durable dispatch-mail -> source-message correlation (CL-6314) — the
  // record the reply path reads back to thread an agent's answer under
  // the message that woke its turn. Same `db` handle, same reasoning.
  const turnMailCorrelation = createDrizzleTurnMailCorrelationStore(db);
  // Mounted outside the tenant prefix — the sidecar reaches it as a
  // plain inference endpoint, never through tenant-scoped auth, the
  // same way it reaches a real provider's API. Pinned by the heartbeat
  // and workbench-digest workflow seeds (from the deleted seeding
  // package), whose
  // agents never produce text. `config.baseUrl` (not `localhost`) is
  // what makes the URL usable from a sidecar on another machine.
  app.route("/api/chat/noop-inference", createNoopInferenceRoutes());
  // Native cold-boot setup status (CL-8112). Mounted outside the tenant
  // prefix like the noop-inference route: an empty hub has no tenant to
  // scope to, and the first-login hook must read it before any bench
  // exists. Counts come straight off the native user/tenant tables — no
  // workbench package involved.
  app.route(
    "/api/setup",
    createSetupStatusRoutes({
      countUsers: async () =>
        (await db.select({ n: count() }).from(userTable))[0]?.n ?? 0,
      countTenants: async () =>
        (await db.select({ n: count() }).from(tenantTable))[0]?.n ?? 0,
    }),
  );
  // The chat platform's invite-launch fallback: a definition with no
  // model requirements of its own resolves the tenant-catalog default.
  const chatHostInferencePreferencesResolver =
    createWorkbenchHostInferencePreferencesResolver((tenantId) =>
      listDefaultInferencePreferences(db, tenantId),
    );
  // Where a relaunch announces itself in the room (see `@corbits/chat`'s
  // `relaunch-notice.ts`). Armed further down, once the room-message
  // store the poster writes through exists — the platform that fires
  // notices has to be constructed first, since the sweep that triggers
  // most of them hangs off it.
  const relaunchNoticeRef: RelaunchNoticePort = {};
  // One CryptoProviderCache for the whole hub process (CL-7284). Chat
  // sendMail keys by chat id; webhook, routine, and agent-definition
  // drafting first-turn mail key by the launched run's instance id. New
  // chats and run ids are `run_` (`generateId("workflowRun")`);
  // older chats are `ins_` (`generateId("instance")`). They share a
  // string shape — a second cache for the same id would mint a different
  // signing key. generateId uniqueness keeps distinct entities from
  // colliding; sharing the cache keeps the same entity from rotating keys
  // across consumers. TTL-bounded by `createCryptoProviderCache` itself
  // (CL-7223).
  const cryptoProviders = createCryptoProviderCache();
  // Delivers chat's outbound run mail through Interchange's own
  // workflow-run mail-trigger route (CL-7490), in-process against this
  // same `app` — see `@corbits/chat`'s `run-trigger-client.ts` and the
  // `getSession` internal-token check above for how it authenticates.
  const runTrigger = createRunTriggerClient({
    app,
    internalAuthSecret: config.sessionSecret,
  });
  const chatPlatform = createHubChatPlatform({
    db,
    runTrigger,
    repoStore: agentRepoStore.repoStore,
    sidecarRouter,
    eventCollectors,
    credentialCipher,
    toolGrantsForPins,
    cryptoProviders,
    workflowAllocationService,
    // CL-7505: serving-time token refresh — every outbound mail refreshes
    // the tenant's due oauth_token credentials first and pushes the
    // refreshed frames, so the run dials on a live token or fails over
    // past a credential that just went re-auth-required.
    refreshServingCredentials: createTenantServingRefresh({
      store: createDrizzleServingRefreshStore(
        db,
        credentialCipher,
        sidecarRouter,
      ),
      hubUrl: config.baseUrl,
    }),
    // Chat residents are undeployed on idle again (see the comment above
    // this function): `chatIdleReapMs` (env-overridable via
    // `HUB_CHAT_IDLE_REAP_MS`, default 30 minutes) is
    // state-preserving (`IDLE_HIBERNATE_UNDEPLOY_REASON`), unlike a
    // destructive undeploy.
    lifecycle: { idleSleepMs: config.chatIdleReapMs },
    //
    // A hand-authored definition with no model requirements of its own
    // (see `@corbits/agent-directory`'s `createAgentDefinitionCore`
    // doc) still launches on invite by falling back to this same
    // tenant-catalog default, instead of 409ing `not_launchable`.
    workbenchHostInferencePreferences: chatHostInferencePreferencesResolver,
    relaunchNotice: relaunchNoticeRef,
  });
  wireMailRedelivery({ sidecarRouter, chatPlatform });
  // The one SSE subscriber registry for this process's chat events
  // (see `@corbits/chat`'s `workbench-events.ts`), constructed here in
  // the composition root and shared by every consumer below: the chat
  // router bridges it onto `/workbenches/:id/stream`, the
  // workflow-command path publishes through the same instance so a
  // command-started workflow's join event reaches an open stream
  // immediately (exactly like `POST .../invite`'s does), and the
  // orchestrator publishes every message it posts onto a chat's
  // timeline.
  const chatSubscribers = createWorkbenchSubscriberRegistry();
  // One in-flight turn per chat (CL-6331), shared by every send
  // surface below the same way `chatSubscribers` is: the chat
  // router and the workflow-participant router (a workflow child's own
  // sends) all route through this one queue,
  // so a burst arriving through any of them for the same chat
  // still serializes against the others rather than each queue only
  // seeing its own slice of the traffic.
  const turnQueue = createWorkbenchTurnQueue({
    claims: createInMemoryTurnClaimStore({ ttlMs: DEFAULT_TURN_CLAIM_TTL_MS }),
    publish: chatSubscribers.publish,
  });
  // The live abort seam a running turn is reachable through (CL-7201) —
  // shared the same way `turnQueue` above is, so a cancel request lands
  // wherever a chat's turn was actually dispatched from.
  const turnCancellation = createTurnCancelRegistry();
  relaunchNoticeRef.current = createRelaunchNoticePoster({
    store: chatStore,
    roomMessages,
    publish: chatSubscribers.publish,
  });
  // Built once, beside the platform, for the process's lifetime: turns
  // an invited agent's `connector.reply` events into chat messages,
  // and a gate-blocked run's approval park into an in-chat approve
  // block, by subscribing to the sidecar's own event stream, replacing
  // the old per-agent reply-bridge machinery armed (and re-armed) from
  // inside the routes. `chatPlatform.recordActivity` is the same
  // idle-sleep lifecycle `chatPlatform` itself drives — wiring it here
  // too is what keeps a replying agent's activity clock current even
  // though the reply never goes through `chatPlatform.sendMail`'s own
  // `recordActivity` call. `approvals` is the same `ApprovalStore` the
  // platform's own approve/reject routes read and write — this
  // orchestrator only ever reads it.
  const agentTurns = createDrizzleAgentTurnStore(db);
  const chatOrchestratorDeps: Parameters<typeof createChatOrchestrator>[0] = {
    db,
    agentTurns,
    store: chatStore,
    roomMessages,
    publish: chatSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    recordActivity: chatPlatform.recordActivity,
    claims: writeClaims,
    threads: threadStore,
    turnMailCorrelation,
    connectorRegistry: CONNECTOR_REGISTRY,
  };
  const chatOrchestrator = createChatOrchestrator(chatOrchestratorDeps);
  // CL-6644: a loud, unconditional boot confirmation that message intake
  // is actually wired — a composition-root mistake here (an import
  // dropped, a construction reordered, an argument omitted) type-checks
  // fine but produces a hub that accepts messages into a void: no
  // dispatch, no error, no notice, just a message that persists and is
  // never asked of anyone. This can't detect every such mistake (the
  // pieces below are non-optional local bindings, not feature-flagged),
  // but it turns "intake is wired" from an assumption nothing checks
  // into a line every boot log carries — the next investigation starts
  // by grepping for this instead of re-deriving the whole call chain.
  getLogger(["hub", "chat-intake"]).info(
    "Chat message intake wired: turnQueue={hasTurnQueue} " +
      "chatOrchestrator={hasOrchestrator} chatPlatform={hasPlatform}",
    {
      hasTurnQueue: turnQueue !== undefined,
      hasOrchestrator: chatOrchestrator !== undefined,
      hasPlatform: chatPlatform !== undefined,
    },
  );
  // A room participant that died with its sidecar is otherwise silently
  // dead until somebody writes into it, and the turn the crash
  // interrupted never surfaces at all — the run that died never sends
  // the `message.run.ended` the orchestrator's turn-drop notice hangs
  // off. The sweep finds those runs and relaunches each one, posting
  // its notice.
  //
  // A series of passes rather than one, because "this run is dead" is
  // not knowable at the instant the execution plane comes back: the
  // terminal event is committed to the run's durable log by the dying
  // sidecar and reaches `workflow_run.status` only once the restarted
  // sidecar has packed it back to the hub, seconds later. The series is
  // bounded and re-armed by a sidecar disconnect, which is the one
  // event that can newly orphan a room.
  const relaunchSweepLog = getLogger(["chat", "relaunch-sweep"]);
  const RELAUNCH_SWEEP_DELAYS_MS = [0, 2_000, 5_000, 15_000, 45_000];
  // Bumped by every reschedule so a pass still in flight from the
  // previous series retires instead of continuing beside the new one.
  let relaunchSweepSeries = 0;
  let relaunchSweepTimer: ReturnType<typeof setTimeout> | undefined;
  function runNextRelaunchSweepPass(series: number, pass: number): void {
    const delay = RELAUNCH_SWEEP_DELAYS_MS[pass];
    if (delay === undefined || series !== relaunchSweepSeries) return;
    const timer = setTimeout(() => {
      void chatPlatform
        .sweepTerminalRuns()
        .catch((cause: unknown) => {
          relaunchSweepLog.error`relaunch sweep pass failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        })
        .finally(() => {
          runNextRelaunchSweepPass(series, pass + 1);
        });
    }, delay);
    timer.unref?.();
    relaunchSweepTimer = timer;
  }
  function scheduleRelaunchSweep(): void {
    clearTimeout(relaunchSweepTimer);
    relaunchSweepSeries += 1;
    runNextRelaunchSweepPass(relaunchSweepSeries, 0);
  }
  scheduleRelaunchSweep();
  sidecarRouter.events.on("sidecar.disconnect", () => {
    scheduleRelaunchSweep();
  });
  // Now that `chatStore`/`chatPlatform` exist, arm the finalized-turn
  // artifact-delivery ref declared beside `eventCollectors` above.
  const artifactDeliveryHandlerDeps: Parameters<
    typeof createArtifactDeliveryHandler
  >[0] = {
    db,
    store: chatStore,
    roomMessages,
    publish: chatSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    claims: writeClaims,
    agentTurns,
    threads: threadStore,
    turnMailCorrelation,
    providerHealth: createProviderHealthPort(providerHealthStore),
    listConnectedProviders: (tenantId) => listConnectedProviders(db, tenantId),
  };
  artifactDeliveryHandlerRef.current = createArtifactDeliveryHandler(
    artifactDeliveryHandlerDeps,
  );
  // The "/name args" and "@name args" command registry: every tenant's
  // invitable workflow definitions, exposed as commands by
  // `createWorkflowCommandPlugin`, resolved fresh on every list/lookup
  // so a newly-deployed definition is a command on its very next use —
  // no re-registration step. `startWorkflow` is `@corbits/chat`'s own
  // `startWorkflowCommand`, sharing the exact invite-then-send core
  // `POST .../invite` uses, including its live `publish` — bound to
  // `chatSubscribers` above, the same registry `createChatRoutes`
  // is given below.
  const commandRegistry = createCommandRegistry();
  commandRegistry.registerCommandPlugin(
    createWorkflowCommandPlugin({
      listInvitableDefinitions: (tenantId) =>
        chatPlatform.listInvitableDefinitions(tenantId),
      startWorkflow: (input) =>
        startWorkflowCommand(
          {
            store: chatStore,
            platform: chatPlatform,
            roomMessages,
            publish: chatSubscribers.publish,
          },
          input,
        ),
    }),
  );

  // The one "is this a conversational agent?" ruling, shared by every
  // picker that offers agents to a person and by a routine's `"agent"`-kind
  // trigger-field validation below: a catalog workflow whose entry says
  // `conversational: false` (routine/automation material — Echo, "Last 30
  // days research report", …) and chat-host anchor definitions
  // (chat's own plumbing, never a person-facing agent) belong in neither.
  // `isConversationalWorkflowName`, not `isAutomatableWorkflowName`: a
  // non-automatable utility workflow (Echo, the research report a routine
  // delivers) is still not conversational, and the old automatable-only
  // check let both leak into every agent picker (CL-6649).
  const isConversationalAgentDefinition = (definition: { name: string }) =>
    isConversationalWorkflowName(definition.name) &&
    !isWorkbenchHostDefinitionName(definition.name);

  // A second, narrower ruling layered on top of the ruling above, for
  // LISTING/PICKER surfaces only. A planner-created agent (the
  // now-deleted tasks primitive's planner `{create}` branch, CL-6051;
  // see `@corbits/agent-directory`'s `stale-task-agent-naming.ts`)
  // existed for exactly one now-retired task; any that still linger
  // must stay out of a picker meant for agents a person deliberately
  // keeps around. Wired into the picker surface: chat's invite/new-chat
  // dialogs (`chatDeps.isInvitableDefinition` below).
  const isPickerListableDefinition = (definition: { name: string }) =>
    isConversationalAgentDefinition(definition) &&
    !isPlannerCreatedDefinitionName(definition.name);

  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: chatStore,
    roomMessages,
    platform: chatPlatform,
    principals: createDrizzleNativePrincipalStore(db),
    threads: threadStore,
    turnMailCorrelation,
    agentTurns,
    turnTextSnapshot: (input) =>
      createDrizzleTurnTextSnapshotReader(db).read(input),
    blockResponses: blockResponseStore,
    reactions: reactionStore,
    pins: pinStore,
    clientIds: createDrizzleClientIdStore(db),
    workbenchSubscribers: chatSubscribers,
    turnQueue,
    turnCancellation,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    isInvitableDefinition: isPickerListableDefinition,
    turnTimeoutMs: DEFAULT_TURN_CLAIM_TTL_MS,
    resolvePrincipalName: async (_tenantId, principalId) => {
      const principalRow = await db.query.principal.findFirst({
        where: (p, { eq: equals }) => equals(p.id, principalId),
        columns: { kind: true, refId: true },
      });
      if (principalRow === undefined || principalRow.kind !== "user") {
        return undefined;
      }
      const userRow = await db.query.user.findFirst({
        where: (u, { eq: equals }) => equals(u.id, principalRow.refId),
        columns: { name: true },
      });
      return userRow?.name ?? undefined;
    },
    commands: commandRegistry,
    // The same native undeploy call the idle-sleep lifecycle uses to
    // tear an invited agent's instance down (see `chatPlatform`'s own
    // `lifecycle.undeploy` above) — wired here too so removing an agent
    // from a chat's participants releases its running instance the
    // same way, rather than leaving it deployed with nothing routing
    // messages to it.
    releaseAgentInstance: (address, reason) =>
      sidecarRouter.sendAgentUndeploy(address, reason),
    // CL-7450: fans a sent human message into every human participant's
    // `@corbits/mailbox` inbox, on the same `mailboxDb`/`mailboxBus` every
    // other mailbox consumer in this file shares. `resolveKnownPrincipalIds`
    // reads the control plane's own `principal` table directly (the
    // authoritative "is this a real principal in this tenant" check),
    // rather than `@corbits/mailbox`'s FK, so an unknown participant is a
    // reported skip, not a database error deep in a transaction.
    mailbox: {
      writer: createDrizzleMailboxWriter(mailboxDb, mailboxBus),
      resolveKnownPrincipalIds: async (tenantId, candidateIds) => {
        if (candidateIds.length === 0) return new Set();
        const rows = await db.query.principal.findMany({
          where: (p, { eq: equals, and: andAll }) =>
            andAll(equals(p.tenantId, tenantId), inArray(p.id, candidateIds)),
          columns: { id: true },
        });
        return new Set(rows.map((row) => row.id));
      },
      // A row's Message-ID always addresses under the row's OWN tenant's
      // domain, never the acting caller's — see `mailbox-fanout.ts`'s
      // `MailboxFanoutDeps.resolveTenantDomain` doc comment. Same
      // `tenant` lookup `workflowDeployer.deploy` above uses for the
      // identical reason (an instance's trigger address, minted against
      // its own tenant's domain).
      resolveTenantDomain: async (tenantId) => {
        const tenantRow = await db.query.tenant.findFirst({
          where: eq(tenantTable.id, tenantId),
        });
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${tenantId}" to address a mailbox from`);
        }
        return tenantRow.domain;
      },
    } satisfies MailboxFanoutDeps,
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));
  // Myra's workflow-run chat surfaces (`@corbits/agent-directory-tools`'
  // `create_agent` default mint-dm + invite for non-chat kinds): the
  // workflow-run-authenticated counterpart to browser chat routes,
  // self-WORKBENCH scoped — see `@corbits/chat`'s
  // `workflow-participant-routes.ts` for the [Intx/repo gap] this resolves
  // around (no direct run-address -> chat index; resolved by scanning
  // the tenant's chat participant lists).
  app.route(
    "/api/workflow-chat",
    createWorkflowParticipantRoutes({
      store: chatStore,
      platform: chatPlatform,
      roomMessages,
      publish: chatSubscribers.publish,
      turnQueue,
      turnCancellation,
      turnMailCorrelation,
      authenticator: createWorkflowRunAuthenticator({ db }),
    }),
  );
  // Product inbox over `@corbits/mailbox` — three groups, mark-all-read
  // (mentions + deliveries only), clear-done. The raw package surface
  // (including SSE events) mounts under `/mailbox` for hosts and tools
  // that need the universal API.
  app.route(
    `${TENANT_PREFIX}/inbox`,
    createInboxRoutes({ db: mailboxDb, bus: mailboxBus }),
  );
  // Insights usage sink + read API. Package-owned tables are migrated
  // at hub start (idempotent ledger); the store is Postgres-backed so
  // numbers survive restarts. Absent rates / pre-sink history stay null.
  // runTraceReader reads the platform's own workflow_run /
  // inference_turn / turn_part tables directly
  // (see @corbits/insights' createDrizzleRunTraceReader) — no new storage,
  // same `db` handle every other platform-table reader in this file uses.
  // The sink itself is constructed earlier, alongside `eventCollectors`
  // (see the `onUsage` hook on `createEventCollectorRegistry` above),
  // which reports each finalized turn's usage with its run identity.
  app.route(
    `${TENANT_PREFIX}/insights`,
    createInsightsRoutes({
      store: insightsUsage.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      runTraceReader: createDrizzleRunTraceReader(db),
      latencyStore: insightsLatency.store,
      // Same `db` handle every other platform-table reader in this file
      // uses — lets /usage, /activity, /tools, and /scope roll up a
      // workspace parent's child chats (see resolveScope in
      // @corbits/insights' routes.ts).
      db,
    }),
  );
  // A workflow definition's own detail page (CL-7371): what it is,
  // whether it can run right now, its steps, and its access surface.
  // Mounted alongside — not inside — the vendored
  // `createWorkflowDefinitionRoutes` (`vendor/intx/hub-api/src/app.ts`
  // already mounts that one at this same `/workflows/definitions`
  // prefix): this GET is a hub-composed read over native
  // rows, so it lives in `@corbits/workflows`'s `./detail`, not the
  // vendored tree.
  app.route(
    `${TENANT_PREFIX}/workflows/definitions`,
    createWorkflowDetailRoute({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Hub-zero T4 (CL-8126): the scheduled delivery join is cut — a
  // triggered run launches straight into the runner with no
  // settings-row lookup and no chat join. Pre-cutover rows carry no
  // migration burden: the join never persisted anything (it read the
  // settings registry and joined the run to a chat in memory per
  // trigger), so there is no backfill and no default to apply.
  app.route(
    `${TENANT_PREFIX}/workflows`,
    createScheduledWorkflowRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      runNow: async (args) =>
        runNowScheduledDefinition(
          { db, sidecarRouter },
          {
            tenantId: args.tenantId,
            definitionId: args.definitionId,
            principalId: args.principalId,
            fromDomain: args.fromDomain,
            content: args.content,
            name: args.name,
            definitionAssetId: args.assetId,
          },
        ),
    }),
  );
  // Run key identity diagnostics: read side of the append-only
  // `run_key_history` table above — per-run key lifecycle, divergence
  // against `workflow_run.public_key`, and tenant-wide counts by
  // identity state, so diagnosing a stranded run never again requires
  // hand-comparing a sidecar's on-disk key against this table.
  app.route(
    `${TENANT_PREFIX}/run-key-history`,
    createRunKeyHistoryRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Preferences: a single per-(tenant, principal) JSONB bag for small UI
  // choices a surface wants to remember across reload (col2 collapse,
  // theme, ...). Package-owned table, migrated at hub start like insights.
  await applyPreferencesMigrations(config.databaseUrl);
  const preferences = createPostgresPreferencesStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/preferences`,
    createPreferencesRoutes({
      store: preferences.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Bench model policy: what a bench will and will not spend inference on.
  // Package-owned table, migrated at hub start like insights and
  // preferences. A bench with no row is unconstrained, so a freshly
  // connected bench needs no configuration to get an answer.
  await applyInferenceCatalogMigrations(config.databaseUrl);
  const benchModelPolicy = createPostgresBenchModelPolicyStore(
    config.databaseUrl,
  );
  app.route(
    `${TENANT_PREFIX}/bench-model-policy`,
    createBenchModelPolicyRoutes({
      store: benchModelPolicy.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Resolved catalog offerings: the same ancestor-inheriting view
  // `listVisibleOfferings` gives `workflowDeployer` above, exposed over
  // HTTP so an out-of-process deployer (`workbench seed`) can deploy
  // against exactly what the hub itself would deploy against, not just
  // the offerings a tenant owns directly.
  app.route(
    `${TENANT_PREFIX}/catalog/resolved-offerings`,
    createResolvedOfferingsRoutes({
      listOfferings: (tenantId) => listVisibleOfferings(db, tenantId),
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Bench purpose/type: benches are Interchange tenants, so this is a
  // package-owned side-table keyed by tenant id, migrated at hub start
  // like insights and preferences.
  await applyBenchMigrations(config.databaseUrl);
  const benchSettings = createPostgresBenchSettingsStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/bench-settings`,
    createBenchRoutes({
      store: benchSettings.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Eval run history: read-only surface over the package-owned
  // `evals.run` table, migrated at hub start like insights and
  // bench-settings. Eval runs aren't tenant-owned (same as
  // run-key-history), so the tenant prefix here is only the grant gate.
  await applyEvalsMigrations(config.databaseUrl);
  const evalRuns = createPostgresEvalRunStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/eval-runs`,
    createEvalRunRoutes({
      store: evalRuns.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  {
    const mailboxApp = new Hono<TenantEnv>();
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      vocabulary: WORKBENCH_MAILBOX_VOCABULARY,
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
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  // CL-7361: the `deploy` half of the run-authenticated deployer this
  // route's registry calls — the SAME `prepareProvisionedDeployment` the
  // native `POST /workflows/deployments` route drives. Inference sources
  // ride as catalog offering ids (`listVisibleOfferings`); an agent never
  // supplies or sees a provider secret. The tree is already on the asset
  // at `commitSha`, so this does not re-populate.
  //
  // `wf_deploy_preview` (CL-7362) is NOT wired through this
  // deployer. `registry.previewDeploy` does a static, read-only render of
  // the already-committed source at `commitSha` straight off `RepoStore`.
  const workflowDeployer: WorkflowDeployer = {
    async deploy({ tenantId, principalId, assetId, commitSha, entry }) {
      const tenantRow = await db.query.tenant.findFirst({
        where: eq(tenantTable.id, tenantId),
      });
      if (tenantRow === undefined) {
        throw new WorkflowAuthorError(
          "not_found",
          `tenant ${tenantId} not found`,
        );
      }

      const offerings = [...(await listVisibleOfferings(db, tenantId))].sort(
        (a, b) => a.offering.priority - b.offering.priority,
      );
      const sourceOfferingIds = offerings.map((o) => o.offering.id);
      const defaultSourceOfferingId = sourceOfferingIds[0];
      if (defaultSourceOfferingId === undefined) {
        throw new WorkflowAuthorError(
          "invalid",
          "no catalog offerings visible to this tenant",
        );
      }

      try {
        const sessionId = generateId("session");
        const prepared =
          await workflowAllocationService.prepareProvisionedDeployment({
            tenantId,
            anchorRunId: generateId("workflowRun"),
            deploymentDomain: tenantRow.domain,
            source: {
              kind: "asset",
              assetId,
              package: { format: "source", commitSha },
            },
            entry,
            definitionAssetId: assetId,
            sessionId,
            sourceAuthorityPrincipalId: principalId,
            sourceOfferingIds,
            defaultSourceOfferingId,
            deployContent: { systemPrompt: "" },
          });
        // The eager record every native launcher makes right after
        // `prepareProvisionedDeployment` returns (CL-7481): this
        // deployment mints no opening message of its own, but the
        // trigger that eventually reconciles a principal onto it runs
        // entirely through Interchange's own native route, with no
        // hub-owned hook downstream to record the session
        // afterward — so this is the only chance to record it at all.
        await recordAgentSessionAtProvision({
          db,
          eventCollectors,
          runId: prepared.anchorRunId,
          sessionId,
          sourceAuthorityPrincipalId: principalId,
        });
        return {
          deploymentId: prepared.anchorRunId,
          definitionAssetId: assetId,
          status: prepared.status,
        };
      } catch (err) {
        // Mirrors `@intx/hub-api`'s own `/workflows/deployments` route: an
        // install/gate rejection or an unapproved source chain is a
        // client/definition error; a provisioning failure or anything else
        // (a missing commit, an unreachable sidecar) is `unavailable`.
        if (err instanceof WorkflowDefinitionInvalidError) {
          throw new WorkflowAuthorError("invalid", err.message);
        }
        if (err instanceof WorkflowProvisioningError) {
          throw new WorkflowAuthorError("unavailable", err.message);
        }
        reportError(err, {
          operation: "workflow-author-deploy",
          tenantId,
        });
        throw new WorkflowAuthorError(
          "unavailable",
          err instanceof Error ? err.message : "Failed to deploy workflow",
        );
      }
    },
  };
  // Agent-authored workflows (CL-7360, CL-7361): an agent publishes a
  // workflow codebase as a native `kind:"workflow"` asset AND deploys it,
  // both through this workflow-run-authenticated surface — `deploy`
  // reaches the exact same `prepareProvisionedDeployment` the
  // tenant-session `/workflows/deployments` route drives (`workflowDeployer`
  // above), never a second gating path. Unlike `/api/workflow-skills`
  // above, every write here also runs a real `chatGrantStore`
  // authorization check (`asset:*`/create, `asset:<id>`/write,
  // `workflow:*`/create) before reaching `RepoStore` or the deploy call,
  // because authoring and deploying are side effects, not a markdown
  // skill edit.
  app.route(
    "/api/workflow-workflow-authoring",
    createWorkflowAuthorRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: createWorkflowAuthorRegistry({
        db,
        assetService,
        repoStore: agentRepoStore.repoStore,
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
        deployer: workflowDeployer,
      }),
    }),
  );
  app.route(
    `${TENANT_PREFIX}/chat`,
    createCommandRoutes({
      registry: commandRegistry,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      workbenchBelongsToTenant: async (tenantId, chatId) =>
        (await chatStore.getWorkbenchSettings(tenantId, chatId)) !==
          undefined || (await chatStore.hasLaunchedInstance(tenantId, chatId)),
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
  const webhookTriggerStore = createDrizzleWebhookTriggerStore(
    db,
    credentialCipher,
  );
  app.route(
    `${TENANT_PREFIX}/webhook-triggers`,
    createWebhookTriggerRoutes({
      store: webhookTriggerStore,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
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
            sessionService,
            repoStore: agentRepoStore.repoStore,
            workflowAllocationService,
            credentialCipher,
            eventCollectors,
            isRoutable: isSidecarRoutable,
            cryptoProviderCache: cryptoProviders,
            persistLaunch: async (input) => {
              await workbenchLaunchPersistExtra(input)(db);
            },
            recordLaunchSources: ({ instanceId, sourcesDigest }) =>
              recordSourcesDigest(db, instanceId, sourcesDigest),
          },
          trigger,
          payload,
        ),
    }),
  );
  // A connection completing through ANY door below — OAuth callback,
  // pasted key, MCP OAuth, keyless MCP preset — settles every room
  // waiting on that connector: the room's `connections/pending` entry
  // clears (flipping the in-room connect card via `chat.settings`).
  // Rooms with `connections/pending` still wake the host agent via
  // `dispatchTurn` without a forged signed-in-user timeline row;
  // code-review template rooms are not woken on PAT settle.
  //
  // An inference provider's credential landing also re-checks every
  // live participant's deployed inference chain (CL-6687): a rotated
  // key only ever reaches an agent at deploy time, so the relaunch has
  // to be kicked here, not left for the next message. A tool-package
  // connector (`feedsTools`, e.g. Manus) is the same shape for a
  // different payload: `pinnedPackageCredentialBindingsFor` only folds
  // at deploy, so a live Myra launched at signup before the key was
  // pasted stays on a snapshot that cannot `resolve("manus")` until
  // this pass relaunches it. Not awaited — a relaunch is a sidecar
  // deploy round-trip, and the connect response must not wait on it.
  const settleServiceConnection: ServiceConnectedHook = async (info) => {
    await settleConnectedService(
      {
        store: chatStore,
        platform: chatPlatform,
        roomMessages,
        publish: chatSubscribers.publish,
        agentTurns,
      },
      {
        tenantId: info.tenantId,
        principalId: info.principalId,
        connectorId: info.connectorId,
        displayName: info.displayName,
      },
    );
    if (isInferenceProvider(info.connectorId)) {
      void chatPlatform
        .reconcileInferenceSources(info.tenantId)
        .then(({ scanned, relaunched }) => {
          log.info`inference credential ${info.connectorId} changed on tenant ${info.tenantId}: re-checked ${String(scanned)} live agents, relaunched ${String(relaunched)}`;
        })
        .catch((cause: unknown) => {
          reportError(cause, {
            operation: "connections.reconcile-inference-sources",
            tenantId: info.tenantId,
          });
        });
    }
  };
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
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
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
      listConnectedProviders: (tenantId) =>
        listConnectedProviders(db, tenantId),
      // CL-6403: an operator-set GITHUB_API_BASE_URL lets a fake server
      // stand in for api.github.com for the `github` connector's PAT
      // probe and stored provider origin; unset in every real deployment,
      // so `probeBaseUrls` is empty and every connector probes its own
      // fixed production origin.
      probeBaseUrls:
        config.githubApiBaseUrl !== undefined
          ? { github: config.githubApiBaseUrl }
          : {},
      onConnected: settleServiceConnection,
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
      onConnected: settleServiceConnection,
      defaultReturnPath: "/settings/connections",
      // `/w/` is the chat room prefix: the in-room connect card
      // (CL-6393) starts OAuth from a room and must land back in it.
      returnPathAllowlist: [
        ...DEFAULT_RETURN_PATH_ALLOWLIST,
        "/plugins",
        "/w/",
      ],
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
  // Template block workflows (CL-6405, cut over to native deploy in
  // CL-7364): the instantiate path's `deployBlockWorkflow` port lands
  // here — the same source-form materialization pattern (asset +
  // `@corbits/workflows`'s `./source` tree) applied to a template's referenced
  // block definition (`code-review` today), now deployed through the
  // same `workflowDeployer` the agent-authored deploy path above uses
  // rather than a hub-local inert freeze.
  app.route(
    `${TENANT_PREFIX}/template-blocks`,
    createTemplateBlockRoutes({
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      inferencePreferences: (tenantId) =>
        chatHostInferencePreferencesResolver(tenantId),
      deployWorkflowSource: async ({
        tenantId,
        principalId,
        assetName,
        displayName,
        workflowJson,
      }) => {
        const existing = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.name, assetName),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true },
        });
        if (existing !== undefined) {
          return { id: existing.id, created: false };
        }

        // A prior attempt may have created the asset but died before the
        // definition projected — reuse the shell instead of 409ing the
        // retry, the same recovery `createAgentDefinitionCore` documents.
        let assetId: string;
        try {
          const created = await assetService.createAsset({
            tenantId,
            kind: "workflow",
            name: assetName,
            displayName,
            creatorPrincipalId: principalId,
          });
          assetId = created.id;
        } catch (cause) {
          const shell = await db.query.asset.findFirst({
            where: and(
              eq(assetTable.tenantId, tenantId),
              eq(assetTable.kind, "workflow"),
              eq(assetTable.name, assetName),
            ),
            columns: { id: true },
          });
          if (shell === undefined) throw cause;
          assetId = shell.id;
        }

        const { commitSha } = await assetService.populateAsset({
          assetId,
          ref: DEFAULT_ASSET_REF,
          principal: { kind: "hub" },
          tree: {
            files: renderWorkflowSourceTree({
              packageName: `@workbench-template/${assetName}`,
              workflowJson,
            }),
            message: `Deploy template block ${assetName}`,
          },
        });

        // Native deploy, not a hub-local inert freeze (CL-7364): the same
        // `workflowDeployer` the agent-authored deploy path above drives,
        // so a template block's definition goes through the real
        // bundle → sidecar probe → capability walk → gate → freeze
        // pipeline instead of a hub-side shortcut.
        const result = await workflowDeployer.deploy({
          tenantId,
          principalId,
          assetId,
          assetName,
          commitSha,
          entry: WORKFLOW_SOURCE_ENTRY,
        });
        return { id: result.definitionAssetId, created: true };
      },
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
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      presets: MCP_PRESETS,
      onConnected: settleServiceConnection,
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
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      credentialCipher,
      presets: MCP_PRESETS,
      onConnected: settleServiceConnection,
      // `/w/` for the same reason as the connections/oauth mount above.
      returnPathAllowlist: [
        ...DEFAULT_RETURN_PATH_ALLOWLIST,
        "/plugins",
        "/w/",
      ],
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
      registry: CONNECTOR_REGISTRY,
      // Same `isConnectorConnected` the pinned-package factory is wired
      // with above (CL-6492).
      isConnectorConnected,
      listMcpServers: (tenantId) => listMcpServerConnections(db, tenantId),
    }),
  );
  // How a running agent asks what this bench can reach for a kind of work
  // (`@corbits/catalog-tools`' `list_model_concepts` / `pick_models` /
  // `estimate_run_cost`): the workflow-run-authenticated counterpart to
  // the tenant-session bench-model-policy mount above. Read-only, and it
  // takes ports rather than a db handle, so the package never learns the
  // catalog schema.
  app.route(
    "/api/workflow-inference-catalog",
    createWorkflowCatalogRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      listOfferings: (tenantId) => listVisibleOfferings(db, tenantId),
      listPricing: async (_tenantId, offeringIds) =>
        offeringIds.length === 0
          ? []
          : await db.query.modelPricing.findMany({
              where: inArray(modelPricing.offeringId, [...offeringIds]),
            }),
      getPolicy: (tenantId) => benchModelPolicy.store.getPolicy(tenantId),
    }),
  );
  // Myra's own principal/grant surface (`@corbits/access-tools`'
  // `list_principals`/`list_grants`/`grant_access`/`revoke_access`): the
  // workflow-run-authenticated counterpart to the tenant-session
  // `/api/tenants/:tenantId/principals` and `/grants` routes
  // `@intx/hub-api` mounts above. Reuses the SAME `chatGrantStore`/
  // `chatConditionRegistry` every other extension's own requireGrant
  // check runs against, so a seeded principal's real grants (see
  // the deleted seeding package's `SEED_GRANTS`) gate this surface exactly like
  // every other write route.
  app.route(
    "/api/workflow-access",
    createWorkflowAccessRoutes({
      db,
      authenticator: createWorkflowRunAuthenticator({ db }),
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
  );
  // Notify-to-reconnect for an OAuth-connected credential whose token
  // expired (Hugging Face today — see docs/onboarding-huggingface-connect.md):
  // a light periodic sweep over `@corbits/notify`'s pure
  // `findDueCredentialExpiries`, mailing through the hub's notify delivery
  // deps (`createHubNotifyDeliveryDeps`). `createInMemoryNotifyDispatchStore`/`createSinkRegistry()`
  // mean external sink fan-out (Slack, email) is a no-op until a sink is
  // registered — the mailbox row itself is what a person sees in their
  // inbox. Requires `@corbits/mailbox`'s and `@corbits/notify`'s own
  // migrations applied against `DATABASE_URL`, same as any other
  // consumer of this delivery adapter.
  const notifyHost = new URL(config.baseUrl).host;
  const credentialExpirySweep = createCredentialExpirySweep({
    store: createDrizzleCredentialExpirySweepStore(
      db,
      credentialCipher,
      sidecarRouter,
    ),
    hubUrl: config.baseUrl,
    notify: createHubNotifyDeliveryDeps({
      mailboxDb,
      bus: mailboxBus,
      host: notifyHost,
    }),
  });

  // Reopen a snoozed inbox item once its `until` has passed (CL-7208) — a
  // light periodic sweep over `@corbits/inbox`'s own snooze table, on the
  // same mailboxDb/mailboxBus every other mailbox consumer here shares.
  const inboxUnsnoozeSweep = createInboxUnsnoozeSweep({
    store: createDrizzleInboxUnsnoozeSweepStore(mailboxDb),
    bus: mailboxBus,
  });

  // Recurring auto-fire: `workflow-scheduler.ts` ticks authored, deployed
  // definitions whose frozen projection carries a native ScheduleTrigger.
  // This hub has no general job-runner today, so the loop is scoped to
  // exactly that job rather than standing up a bespoke cron daemon as a
  // hidden dependency. Every hub replica can safely run it: each native
  // fire is claimed on `workflow_definition.schedule_claimed_minute`.
  const workflowScheduler = createWorkflowScheduler({
    listScheduledDefinitions: listScheduledDefinitionsFromDb(db),
    claimScheduleMinute: claimScheduleMinuteFromDb(db),
    launch: launchScheduledDefinitionFromDb({
      db,
      sidecarRouter,
    }),
    ...(config.routineSchedulerPollIntervalMs !== undefined
      ? { pollIntervalMs: config.routineSchedulerPollIntervalMs }
      : {}),
  });

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));

  // Stock Interchange currently leaves tenant creation and dispatch ungated.
  const inFlight = createInFlightRequestTracker();
  const servingApp = withInFlightRequestTracking(app, inFlight);

  return {
    app: servingApp,
    whenRequestsIdle: () => inFlight.whenIdle(),
    db,
    close: async () => {
      sidecarAllocationReconciliationStopped = true;
      if (sidecarAllocationReconciliationTimer !== undefined) {
        clearTimeout(sidecarAllocationReconciliationTimer);
      }
      // Retire the relaunch sweep's series so any in-flight pass's
      // `.finally` reschedule is a no-op, and cancel whatever pass is
      // currently pending. Without this the sweep outlives `close()`
      // entirely (it's only ever re-armed, never torn down) and keeps
      // querying `chat.workbench_launch` on a timer this function is
      // about to end — including, once `close()` below tears down the
      // db pool, querying a pool that's already shut down. In a test
      // suite that boots many hubs back to back (CL-7453) those leaked
      // timers pile up across the whole `bun test` process and contend with later
      // tests' own boots for Postgres connections, which is what
      // surfaced as `chat·relaunch-sweep: relaunch sweep pass failed:
      // Failed query: select ... from chat.workbench_launch` and an
      // intermittent test timeout.
      relaunchSweepSeries += 1;
      clearTimeout(relaunchSweepTimer);
      chatOrchestrator.dispose();
      workflowScheduler.stop();
      credentialExpirySweep.stop();
      inboxUnsnoozeSweep.stop();
      await insightsUsage.close();
      await insightsLatency.close();
      await preferences.close();
      await benchSettings.close();
      await evalRuns.close();
      await closeMailbox();
      // The pool end waits on in-flight queries; a query whose socket
      // died with the process must never stall shutdown, so bound it.
      // (CL-7584: a fire-and-forget reconcile's request can be cut
      // mid-query by this very teardown.)
      await Promise.race([
        close(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
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
    (url.port === ""
      ? url.protocol === "https:"
        ? 443
        : 80
      : Number(url.port));
  const server = Bun.serve({
    fetch: hub.app.fetch,
    websocket,
    port,
    idleTimeout: 0,
  });
  const log = getLogger(["hub"]);
  log.info`Hub serving on port ${port}`;
  const SHUTDOWN_DRAIN_MS = 10_000;
  // In-flight Hono handlers (a request mid-Postgres-transaction, a git
  // write, anything that has not returned a Response yet) must finish
  // before connections are torn down. `server.stop()` with no argument
  // also waits for SSE bridges and idle sidecar websockets, which never
  // close on their own — so once handlers are idle, force-close what's
  // left. A live stream must not turn this drain into a timeout fault.
  const shutdown = () =>
    shutdownHub({
      drain: () =>
        drainHubServer({
          whenRequestsIdle: hub.whenRequestsIdle,
          stop: (force) => server.stop(force),
          close: hub.close,
        }),
      timeoutMs: SHUTDOWN_DRAIN_MS,
      exit: (code) => process.exit(code),
    });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
