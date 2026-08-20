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
  createSidecarAllocationStore,
  createSignalCorrelationStore,
  createWorkflowRunDispatchStore,
  listVisibleOfferings,
  resolveCredentialByName,
} from "@intx/db";
import {
  grant as grantTable,
  model,
  modelPricing,
  role as roleTable,
  tenant as tenantTable,
  workflowDefinition,
} from "@intx/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
  generateKeyPair,
} from "@intx/crypto";
import { authorize, timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import { credentialAad } from "@intx/types";
import type { CredentialBinding, CredentialCipher } from "@intx/types";
import {
  createApp,
  createRequireGrant,
  readDurableWorkflowRunLifecycles,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";

import {
  agentDefinitionSourceTree,
  buildAgentDefinitionWorkflow,
  createAgentDefinitionRoutes,
  createDefinitionAssetHistory,
  createDrizzleDefinitionSkillsStore,
  createWorkflowAgentCreateRoutes,
  createWorkflowCapabilityRoutes,
  createWorkflowSkillPinRoutes,
  reindexPinnedSkills,
  serializeAgentDefinitionWorkflow,
  type CapabilityInventoryProvider,
} from "@corbits/agent-directory";

import {
  AGENT_SECTION_MODE,
  CHAT_TURN_TIMEOUT_MS,
  createArtifactDeliveryHandler,
  createDrizzleAgentTurnStore,
  createInMemoryTurnClaimStore,
  createWorkbenchHostInferencePreferencesResolver,
  createWorkbenchSubscriberRegistry,
  createWorkbenchTenancyRoutes,
  createWorkbenchTurnQueue,
  createChatOrchestrator,
  createChatRoutes,
  joinRunParticipant,
  createDrizzleBlockResponseStore,
  createDrizzleWorkbenchTenancyStore,
  createDrizzleChatStore,
  createDrizzleClientIdStore,
  createDrizzlePinStore,
  createDrizzleReactionStore,
  createDrizzleRoomMessageStore,
  createDrizzleThreadStore,
  createDrizzleWriteClaimStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  createRelaunchNoticePoster,
  findExistingAgentChat,
  createWorkflowParticipantRoutes,
  isWorkbenchHostDefinitionName,
  listConnectedProviders,
  listDefaultInferencePreferences,
  provisionSpaceWorkbench,
  startWorkflowCommand,
  sendWorkbenchMessage,
  workbenchLaunchPersistExtra,
} from "@corbits/chat";
import type { RelaunchNoticePort } from "@corbits/chat";
import type { FinalizedTurnToolCall } from "@corbits/turn-artifacts";
import {
  createCryptoProviderCache,
  createTopLevelRunRoutes,
  lookupFoldedRunReconnectKey,
} from "@corbits/folded-runs";
import {
  createInboxRoutes,
  createWorkbenchMailboxDelivery,
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
  applyInferenceCatalogMigrations,
  createBenchModelPolicyRoutes,
  createPostgresBenchModelPolicyStore,
  createWorkflowCatalogRoutes,
} from "@corbits/inference-catalog";
import {
  createDrizzleSidecarPlacementStore,
  createSidecarPlacementRoutes,
} from "@corbits/sidecar-placement";
import { generateId } from "@intx/hub-common";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
} from "@corbits/mailbox";
import {
  createCommandRegistry,
  createCommandRoutes,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import {
  createDrizzleWebhookTriggerStore,
  createWebhookIngressRoutes,
  createWebhookTriggerRoutes,
  generateWebhookSecret,
  launchWebhookTrigger,
} from "@corbits/webhook-triggers";
import {
  deliveryWorkbenchRequiredForWorkflowName,
  isAutomatableWorkflowName,
  validateTriggerFieldsAtCreate,
  workflowCatalogEntry,
  workflowDisplayName,
  WORKBENCH_TEMPLATES,
  serializeWorkbenchTemplateManifest,
} from "@corbits/workflow-catalog";
import { createConnectGithubRoutes } from "@corbits/workflow-catalog/connect-github-routes";
import {
  createDrizzleDraftStore,
  createDrizzleRoutineStore,
  createMyraRoutineDrafting,
  createRoutineRoutes,
  createWorkflowRoutineRoutes,
  routine as routineTable,
  routineRun as routineRunTable,
  type RoutineDraftInventoryWorkflow,
} from "@corbits/routines";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  createDrizzleTaskStore,
  createStuckLegSweep,
  createTaskOrchestrator,
  createTaskRoutes,
  launchTask,
  launchTaskLeg,
} from "@corbits/tasks";
import {
  createSidecarProvisioner as createE2BSidecarProvisioner,
  readProvisionerConfig as readE2BProvisionerConfig,
} from "@corbits/e2b-sandbox-sidecar";
import {
  createDrizzleRunKeyHistoryStore,
  createRunKeyHistoryListener,
  createRunKeyHistoryRoutes,
  lookupRunKeyHistoryReconnectKey,
} from "@corbits/run-key-history";
import {
  createMyraAgentDefinitionDrafting,
  createPlannerRoutes,
  createWorkflowDispatchRoutes,
  dispatchWithPlanner,
  isPlannerCreatedDefinitionName,
  PlannerDefinitionGrantDeniedError,
  resolveMyraDefinitionIdFromDb,
  runOneShotFoldedPrompt,
  type InventoryAgent,
  type InventoryModel,
  type InventorySources,
  type InventoryToolPackage,
} from "@corbits/task-planner";

import {
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarPluginRegistry,
  createSidecarRouter,
  createSidecarTokenAuthenticator,
  createWorkflowAllocationService,
  createWorkflowDispatchService,
  DEFAULT_ASSET_REF,
  ensureWorkflowDefinitionForAsset,
  type AgentRepoStore,
  type EventCollectorRegistry,
  type WsHandle,
} from "@intx/hub-sessions";
import { createLaunchCaches } from "./launch-caches";
import { wireMailRedelivery } from "./mail-redelivery";
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";
import {
  createNeedsYouRoutes,
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
import { getArtifact, writeArtifactVersion } from "@corbits/artifacts";
import {
  createArtifactDbStore,
  createArtifactRoutes,
  createTemplateLibraryDbStore,
  createTemplateLibraryRoutes,
  createUnavailableArtifactRoutes,
  createUnavailableWorkflowArtifactRoutes,
  createWorkflowArtifactDbStore,
  createWorkflowArtifactRoutes,
  createWorkflowRunAuthenticator,
} from "@corbits/artifacts-hub";
import { createEchoRoutes } from "@workbench/echo";
import {
  createArtifactDocPersistence,
  createPresenceRoomRegistry,
  createPresenceRoutes,
  type PresenceRoomKey,
} from "@corbits/presence";
import { createGitWorkflowPusher, createHubAPI } from "@workbench/hub-client";
import {
  createDrizzlePendingSeedStore,
  createOnboardingRoutes,
} from "@workbench/onboarding";
import {
  createConnectionRoutes,
  createMcpOAuthRoutes,
  createMcpServerRoutes,
  createOAuthConnectRoutes,
  createTenantConnectCredential,
  createWorkflowConnectionRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  listMcpServerConnections,
} from "@workbench/connections";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import {
  createProviderHealthPort,
  createProviderHealthStore,
} from "@workbench/connections/provider-health";
import {
  applyAccessPolicyMigrations,
  createAccessPolicyRoutes,
  createDrizzleAccessPolicyStore,
} from "@workbench/access-policy";
import { guardedHubApp, resolveCallerRoleNames } from "./tenant-create-guard";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
} from "@corbits/notify";
import { mountMemory } from "./memory-mount";
import { mountSkills } from "./skills-mount";
import {
  createUnavailableWorkflowMemoryRoutes,
  createWorkflowMemoryRoutes,
  createWorkflowMemoryStore,
} from "@corbits/memory-hub";
import { createSkillRoutes, createWorkflowSkillRoutes } from "@corbits/skills";
import { mountArtifacts } from "./artifacts-mount";
import { mountWorkbenchSlackTag } from "./slack-tag-mount";
import {
  createCredentialExpirySweep,
  createDrizzleCredentialExpirySweepStore,
} from "./credential-expiry-sweep";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, Hono, type Next } from "hono";

import { upgradeWebSocket, websocket } from "hono/bun";
import {
  CORBITS_TOOLS_REGISTRY,
  describeCorbitsToolPackages,
} from "@corbits/tool-registry-publish";
import {
  readHubConfig,
  type HubConfig,
  type SidecarProvisionerConfig,
} from "./config";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import { scheduleEnvProviderCredentialPlant } from "./env-credential-plant";
import { scheduleTemplateLibrarySeed } from "./template-library-seed";
import { createHubRoutineLauncher } from "./routine-launcher";
import { withTurnPartWriteDefaults } from "./turn-part-content-default";
import { createHubRunSummaryResolver } from "./routine-run-summary";
import { createRoutineScheduler } from "./routine-scheduler";
import { createToolGrantsForPins } from "./tool-grants";
import { createMcpCredentialBindingsFor } from "./mcp-credential-bindings";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const REGISTRIES = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
// In-repo tool packages (`packages/granola-tools`, `packages/linear-tools`,
// `packages/skills-tools`) are unpublished to npm and stay that way:
// they are workbench-specific integration bundles, not general-purpose
// npm packages, so publishing them to a public registry would be the
// wrong distribution surface for what they are. `@intx/hub-sessions`
// already resolves any `package-registry`-kind asset visible to a
// tenant as a named tool-package registry (see `session-service.ts`'s
// `buildAndResolve`), ahead of the statically-configured HTTP
// registries on a name collision — the platform-native alternative to
// npm publishing the CL-5999 capability audit called for. Routing the
// `@corbits` scope at this registry name means a `@corbits/*` pin
// resolves only once an operator seeds a `package-registry` asset named
// `CORBITS_TOOLS_REGISTRY` with the package's tarball — `workbench
// seed`'s `seedTenant` does exactly that, via
// `@corbits/tool-registry-publish`, ahead of deploying any workflow
// that pins a `@corbits/*` package; until then, resolution fails loud
// rather than silently falling through to npmjs (which could never
// carry an unpublished scope anyway).
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
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
//
// `TASK_IDLE_UNDEPLOY_MS` remains for `taskLifecycle` below and stays a
// genuinely different, longer threshold: a spawn-and-return task's
// `wake` is unreachable by construction (a one-shot task never sends a
// follow-up after its opening prompt), so there is nothing a relaunch
// could ever revive — undeploying an idle task-launched resident is
// exactly the intended cleanup once the task's single turn has settled,
// not a case this state-preserving reap needs to cover.
const TASK_IDLE_UNDEPLOY_MS = 8 * 60 * 60 * 1000;

// Signup mode is operator-controlled (WORKBENCH_SIGNUP). Default closed:
// self-serve email signup is rejected; owners add users or share a
// copy-link invite (docs/TENANCY.md). Open mode keeps email+password
// signup and the existing rate limit. Email delivery of invites is out
// of scope.
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
function createStaticHandler(staticDir: string) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    const rel = path
      .normalize(decodeURIComponent(c.req.path))
      .replace(/^[/\\]+/, "");
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
 * in this composition root shares — `webhookTriggerStore`'s signing
 * secrets, `@workbench/onboarding`'s in-flight OAuth connect state
 * (the PKCE verifier parked between `/start` and `/callback`, sealed
 * into the state itself so it survives a restart between the two), and
 * (since CL-6031) the same package's `pending_seed` table — a
 * just-connected credential's plaintext key, parked server-side
 * between the OAuth callback and the onboarding page's own
 * `/complete-setup` follow-up (see `packages/onboarding/src/pending-seed.ts`).
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
          "It encrypts secrets at rest — webhook-trigger signing secrets,",
          "onboarding's OAuth PKCE connect state, and its pending-seed",
          "table — so the hub refuses to boot without it. Generate one and",
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
    log.warn`No CREDENTIAL_ENCRYPTION_KEY configured; secrets (e.g. webhook-trigger signing secrets, onboarding OAuth connect state, onboarding's pending-seed table) will NOT be encrypted at rest. ALLOW_PLAINTEXT_SECRETS is set — expected in dev/test only, never for a real deployment.`;
    return createNoopCredentialCipher();
  }
  return createEnvKeyCredentialCipher(
    Buffer.from(config.credentialEncryptionKeyHex, "hex"),
  );
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
): SidecarProvisioner {
  switch (config.id) {
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
  // Delivery adapter for `@corbits/notify` — kept at the composition root so
  // routine / approval / mention writers can inject it without the hub
  // re-implementing mailbox writes. The credential-expiry sweep below is
  // its first live caller; approval/run-failure/mention still have no
  // writer wired to this adapter.
  const mailboxDelivery = createWorkbenchMailboxDelivery({
    db: mailboxDb,
    bus: mailboxBus,
  });
  const log = getLogger(["hub", "auth"]);
  // Built once and shared by every secret-at-rest seam in this
  // composition root — see `credentialCipherFrom`'s own doc comment.
  const credentialCipher = credentialCipherFrom(config, log);

  const auth = betterAuth({
    baseURL: config.baseUrl,
    secret: config.sessionSecret,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    socialProviders: config.socialProviders,
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
      },
    },
    // No mailer is wired up anywhere in this stack, so better-auth can
    // never actually verify an address -- `emailVerified` would stay
    // false forever and every self-serve signup would dead-end at
    // @workbench/access-policy's gate. `allowUnverifiedEmails`
    // (ALLOW_UNVERIFIED_EMAILS, dev/test only) auto-verifies at the
    // source instead of leaving each downstream consumer of
    // `emailVerified` to separately special-case it.
    databaseHooks: config.allowUnverifiedEmails
      ? {
          user: {
            create: {
              before: async (user: { email: string }) => {
                log.info`ALLOW_UNVERIFIED_EMAILS is set: auto-verifying ${user.email} at account creation (dev/test only)`;
                return { data: { ...user, emailVerified: true } };
              },
            },
          },
        }
      : undefined,
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
  // Shared with `createRunKeyHistoryListener` below: one store instance
  // for the process, read here ahead of `workflow_run` and written to
  // there off every `agent.deploy.ack`.
  const runKeyHistoryStore = createDrizzleRunKeyHistoryStore(db);
  // A folded run (a workbench host, an invited agent, a task) settles
  // "completed" between message occurrences as part of its own normal
  // wake/redeploy cycle — not "done forever" the way a one-shot
  // workflow deployment's "completed" is. The platform's own
  // `lookupPublicKey` gates the reconnect-ownership challenge on
  // `isLiveWorkflowRunStatus` ("deployed"/"running" only), so a folded
  // run reconnecting mid-cycle (its sidecar dials back in, e.g. after a
  // hub restart, while the run happens to be between occurrences) fails
  // that challenge and gets torn down even though nothing about it
  // actually ended. Falling back to `lookupFoldedRunReconnectKey` for a
  // "completed" folded run keeps its reconnect honest without loosening
  // the gate for a real workflow deployment or for a folded run that is
  // genuinely gone ("failed"/"cancelled" still fail closed).
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
  const lookups = {
    ...baseLookups,
    async registerSignalCorrelation(
      args: Parameters<typeof baseLookups.registerSignalCorrelation>[0],
    ): Promise<void> {
      const gate = grantAllowanceGateRef.current;
      if (gate !== undefined) return gate(args);
      return baseLookups.registerSignalCorrelation(args);
    },
    async lookupPublicKey(agentAddress: string): Promise<string | null> {
      // CL-6281: the repair runs before `baseLookups` because the case
      // it exists for is exactly the one `baseLookups` answers WRONGLY —
      // a live run whose `workflow_run.public_key` missed its own
      // `agent.deploy.ack` — so deferring to that answer would never
      // reach the repair at all. It cannot widen which runs may
      // reconnect: it reads the same `liveWorkflowRunStatuses` gate
      // `baseLookups` does, so a retired run still fails closed here.
      // See `@corbits/run-key-history`'s `reconnect.ts` for why
      // preferring this package's own record on disagreement is safe.
      const reconciled = await lookupRunKeyHistoryReconnectKey(
        db,
        runKeyHistoryStore,
        agentAddress,
      );
      if (reconciled !== null) return reconciled;
      const key = await baseLookups.lookupPublicKey(agentAddress);
      if (key !== null) return key;
      return lookupFoldedRunReconnectKey(db, agentAddress);
    },
  };
  const hubPublicKey = hexEncode(signingKey.publicKey);
  // CL-6149: a folded run's pinned tool packages (`toolPackagePins`)
  // carry no grants of their own — the deploy-time capability walk
  // (`vendor/intx/workflow-deploy/src/capability-walk.ts`) only derives
  // `tool:` grants for inline tool factories, so a pinned package's
  // tools failed every call closed with "No matching grants". Every
  // `@corbits/*-tools` package's namespaced tool ids and approval marks
  // are read once here (`describeCorbitsToolPackages`), so
  // `toolGrantsForPins` — the port every `FoldedRunsDeps` below is
  // built with — can synchronously turn a launch's pins into the
  // `tool:<qualifiedId>` grants `@corbits/folded-runs`' `deployAtHead`
  // mints against the run's own principal.
  const toolGrantsForPins = createToolGrantsForPins(
    await describeCorbitsToolPackages(),
  );
  // See `./mcp-credential-bindings.ts`'s own doc.
  const mcpCredentialBindingsFor = createMcpCredentialBindingsFor(db);
  const sidecarRouter = createSidecarRouter({
    hubPublicKey,
    authenticateSidecar: createSidecarTokenAuthenticator({ db }),
    lookups,
  });
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
    onTurnFinalized: (agentAddress, turn) =>
      artifactDeliveryHandlerRef.current?.(agentAddress, turn),
    // The vendored `onUsage` forward (see VENDORED.md) — the platform
    // collector accumulates turns per session but never persisted
    // `inference.usage`; this is the first point tenantId + turnId +
    // provider + model + tokens are all in scope at once.
    onUsage: (_agentAddress, tenantId, sessionId, usage) => {
      void usageSink
        .handle({
          turnId: usage.turnId,
          tenantId,
          sessionId,
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
  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
    agentRepoStore,
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
  const launchAgentRepoStore: AgentRepoStore = {
    writeDeployTree: agentRepoStore.writeDeployTree,
    createDeployPack: agentRepoStore.createDeployPack,
    receiveAgentStatePack: agentRepoStore.receiveAgentStatePack,
    receiveWorkflowRunPack: agentRepoStore.receiveWorkflowRunPack,
    getDeployRef: agentRepoStore.getDeployRef,
    getSigningPublicKey: agentRepoStore.getSigningPublicKey,
    repoStore: launchCaches.repoStore,
  };
  const sessionService = createSessionService({
    sidecarRouter,
    agentRepoStore: launchAgentRepoStore,
    assetService: launchCaches.assetService,
    db,
    toolPackageRegistries: {
      httpRegistries: REGISTRIES,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@corbits", registry: CORBITS_TOOLS_REGISTRY }],
    },
  });
  // Provisioner plugins are injected at the application composition
  // boundary, mirroring @intx/hub-sessions's own reference wiring: the
  // registry always exists, but ships with no provisioners (and no
  // default) until SIDECAR_PROVISIONERS names one or more builds. A
  // workbench's "run this workbench on its own sidecar" setting can then
  // always write a tenant's exclusive `sidecarPlacement`; without any
  // configured provisioner that placement simply fails closed at
  // deployment time rather than silently falling back to the shared
  // sidecar. Adding a new backend here is: implement `SidecarProvisioner`
  // in its own package, add a case to `buildSidecarProvisioner`, and add
  // its id to `apps/hub/src/config.ts`'s `SIDECAR_PROVISIONER_IDS`.
  const sidecarPlugins = createSidecarPluginRegistry({
    provisioners: config.sidecarProvisioners.map((provisionerConfig) =>
      buildSidecarProvisioner(provisionerConfig, config.hubDataDir),
    ),
    ...(config.defaultSidecarProvisionerId !== undefined
      ? { defaultProvisionerId: config.defaultSidecarProvisionerId }
      : {}),
  });
  const workflowAllocationService = createWorkflowAllocationService({
    db,
    plugins: sidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    allocationRouter: sidecarRouter,
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
  const hubWebSocketUrl =
    config.sidecarWebSocketUrl ??
    `${config.baseUrl.replace(/^http/, "ws")}/api/sidecars/ws`;
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
    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: async (c) => {
      // Gate self-serve email signup. Sign-in stays open; only the
      // sign-up/email path is product-controlled (docs/TENANCY.md).
      if (c.req.method === "POST" && c.req.path.endsWith(SIGN_UP_EMAIL_PATH)) {
        if (config.signupMode === "closed") {
          return c.json(
            {
              error: "signup_closed",
              message:
                "Self-serve signup is disabled. Ask an owner for an invite.",
            },
            403,
          );
        }
        if (config.allowedEmailDomains.length > 0) {
          let email = "";
          try {
            const body: unknown = await c.req.raw.clone().json();
            if (
              body !== null &&
              typeof body === "object" &&
              "email" in body &&
              typeof (body as { email: unknown }).email === "string"
            ) {
              email = (body as { email: string }).email.toLowerCase();
            }
          } catch {
            email = "";
          }
          const at = email.lastIndexOf("@");
          const domain = at >= 0 ? email.slice(at + 1) : "";
          const allow = new Set(
            config.allowedEmailDomains.map((d) => d.toLowerCase()),
          );
          if (!allow.has(domain)) {
            return c.json(
              {
                error: "email_domain_not_allowed",
                message: "That email domain is not allowed to sign up.",
              },
              403,
            );
          }
        }
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

  // Extension routes mount under the tenant prefix, inside the
  // platform's native tenant middleware, so every extension handler
  // runs with c.get("tenant") / c.get("principal") resolved.
  app.route(`${TENANT_PREFIX}/echo`, createEchoRoutes());
  // One in-process presence room registry for this process, constructed
  // here in the composition root — the same pattern `workbenchSubscribers`
  // above uses. Presence rooms are ephemeral and process-local by design
  // (see `@corbits/presence`'s docs/presence.md); the registry is built
  // here rather than inside `createPresenceRoutes` itself so the
  // co-editing doc-persistence wiring below (which needs the artifacts
  // engine, mounted further down once its own DB handle resolves) can
  // share the exact same registry the routes below serve traffic
  // through — the same way `startWorkflowCommand` shares
  // `workbenchSubscribers`.
  const presenceRoomRegistry = createPresenceRoomRegistry();
  // Indirection so the join route can call into artifact-doc seeding
  // before the artifacts engine (mounted later, once its DB handle is
  // known) exists. `createPresenceRoutes` is constructed once, here, so
  // its `onJoin` hook has to be a stable function that reads whatever
  // `artifactSeedOnJoin` currently points to — `undefined` (a no-op)
  // until the artifacts mount below assigns it, or forever if the
  // artifacts plane never mounts.
  let artifactSeedOnJoin:
    ((key: PresenceRoomKey, principalId: string) => Promise<void>) | undefined;

  // The "needs you" list: the same `approval:*`/"resolve" grant Interchange's
  // own approve/reject routes require, layered with the agent/bench names
  // this tenant's approvals don't carry on their own. Approving and
  // rejecting still go straight to Interchange's native routes below --
  // this route only ever reads.
  app.route(
    `${TENANT_PREFIX}/approvals/needs-you`,
    createNeedsYouRoutes({
      db,
      grantStore: createGrantStore(db),
      conditionRegistry: { time_window: timeWindowEvaluator },
    }),
  );

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
  // Mounted here (not up with the registry construction above) because
  // its `/update` route's grant gate needs `chatGrantStore`/
  // `chatConditionRegistry`, which don't exist yet up there — the same
  // reason `artifactSeedOnJoin`'s indirection exists, just for a
  // dependency that's ready sooner.
  app.route(
    `${TENANT_PREFIX}/presence`,
    createPresenceRoutes({
      registry: presenceRoomRegistry,
      onJoin: (key, principalId) => artifactSeedOnJoin?.(key, principalId),
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Memory plane (optional): firm-memory HTTP under
  // `/api/tenants/:tenantId/memory/*`, same `DATABASE_URL` as the control
  // plane, isolated in its own `memory` schema. Degrades when EMBED_* is
  // unset — see memory-mount.ts. Captured (not discarded) here, before
  // `chatOrchestrator`/`createArtifactDeliveryHandler` below, so the
  // in-process `Memory` handle can be threaded into both: a finalized
  // turn's persisted artifact and the bounded daily transcript digest
  // (CL-5852) both write through this same handle, never a second
  // connection or the plane's own tenant-session-gated HTTP routes.
  const memoryHandle = await mountMemory({
    app,
    grantStore: chatGrantStore,
    conditionRegistry: chatConditionRegistry,
  });
  const chatStore = createDrizzleChatStore(db);
  const threadStore = createDrizzleThreadStore(db);
  const blockResponseStore = createDrizzleBlockResponseStore(db);
  const reactionStore = createDrizzleReactionStore(db);
  const pinStore = createDrizzlePinStore(db);
  // Durable redelivery-dedup for the finalized-turn write surfaces
  // (CL-6039) — see `WriteClaimStore`'s own doc comment. Same `db`
  // handle as every other Drizzle store above, never a second
  // connection.
  const writeClaims = createDrizzleWriteClaimStore(db);
  // Mounted outside the tenant prefix — the sidecar reaches it as a
  // plain inference endpoint, never through tenant-scoped auth, the
  // same way it reaches a real provider's API. `config.baseUrl` (not
  // `localhost`) is what makes the URL usable: the sidecar that
  // deploys a workbench host's instance is a separate process (often a
  // separate machine) from this hub, so only the hub's own public
  // origin resolves for it.
  app.route("/api/chat/noop-inference", createNoopInferenceRoutes());
  const chatTenancy = createDrizzleWorkbenchTenancyStore(db, {
    conditionRegistry: chatConditionRegistry,
  });
  // Mounted outside the tenant prefix, like `/api/onboarding`: the bench
  // switcher asks this across every tenant a signed-in user belongs to,
  // not one tenant at a time (see `apps/web/src/bench-context.tsx`).
  app.route(
    "/api/workbench-tenancies",
    createWorkbenchTenancyRoutes({ tenancy: chatTenancy }),
  );
  // Shared by the chat platform's invite-launch fallback below and
  // `chatDeps.workbenchHostInferencePreferences` further down — one
  // resolver, derived once, rather than two independent instances of
  // the same tenant-catalog derivation drifting apart.
  const workbenchHostInferencePreferencesResolver =
    createWorkbenchHostInferencePreferencesResolver((tenantId) =>
      listDefaultInferencePreferences(db, tenantId),
    );
  // Where a relaunch announces itself in the room (see `@corbits/chat`'s
  // `relaunch-notice.ts`). Armed further down, once the room-message
  // store the poster writes through exists — the platform that fires
  // notices has to be constructed first, since the sweep that triggers
  // most of them hangs off it.
  const relaunchNoticeRef: RelaunchNoticePort = {};
  const chatPlatform = createHubChatPlatform({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    credentialCipher,
    toolGrantsForPins,
    mcpCredentialBindingsFor,
    noopInferenceBaseUrl: `${config.baseUrl}/api/chat/noop-inference`,
    // Chat residents are undeployed on idle again (see the comment above
    // this function): `chatIdleReapMs` (env-overridable via
    // `WORKBENCH_CHAT_IDLE_REAP_MS`, default 30 minutes) is a genuinely
    // separate threshold from `TASK_IDLE_UNDEPLOY_MS` — chat's reap is
    // state-preserving (`IDLE_HIBERNATE_UNDEPLOY_REASON`) so a much
    // shorter window is safe here, unlike the destructive undeploy a
    // task-launched resident gets.
    lifecycle: { idleSleepMs: config.chatIdleReapMs },
    //
    // A hand-authored definition with no model requirements of its own
    // (see `@corbits/agent-directory`'s `createAgentDefinitionCore`
    // doc) still launches on invite by falling back to this same
    // tenant-catalog default, instead of 409ing `not_launchable`.
    workbenchHostInferencePreferences:
      workbenchHostInferencePreferencesResolver,
    relaunchNotice: relaunchNoticeRef,
  });
  wireMailRedelivery({ sidecarRouter, chatPlatform });
  // The one SSE subscriber registry for this process's workbench events
  // (see `@corbits/chat`'s `workbench-events.ts`), constructed here in
  // the composition root and shared by every consumer below: the chat
  // router bridges it onto `/workbenches/:id/stream`, the
  // workflow-command path publishes through the same instance so a
  // command-started workflow's join event reaches an open stream
  // immediately (exactly like `POST .../invite`'s does), and the
  // orchestrator publishes every message it posts onto a workbench's
  // timeline.
  const workbenchSubscribers = createWorkbenchSubscriberRegistry();
  // One in-flight turn per workbench (CL-6331), shared by every send
  // surface below the same way `workbenchSubscribers` is: the chat
  // router, the workflow-participant router (a workflow child's own
  // sends), and the Slack tag mount all route through this one queue,
  // so a burst arriving through any of them for the same workbench
  // still serializes against the others rather than each queue only
  // seeing its own slice of the traffic.
  const turnQueue = createWorkbenchTurnQueue({
    claims: createInMemoryTurnClaimStore({ ttlMs: CHAT_TURN_TIMEOUT_MS }),
    publish: workbenchSubscribers.publish,
  });
  // The room timeline store (CL-6327): a workbench's own messages, held
  // as workbench data rather than platform mail.
  const roomMessages = createDrizzleRoomMessageStore(db);
  relaunchNoticeRef.current = createRelaunchNoticePoster({
    store: chatStore,
    roomMessages,
    publish: workbenchSubscribers.publish,
  });
  // Built once, beside the platform, for the process's lifetime: turns
  // an invited agent's `connector.reply` events into workbench messages,
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
    publish: workbenchSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    recordActivity: chatPlatform.recordActivity,
    claims: writeClaims,
  };
  if (memoryHandle !== undefined) {
    chatOrchestratorDeps.memory = memoryHandle.memory;
  }
  const chatOrchestrator = createChatOrchestrator(chatOrchestratorDeps);
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
  // `memory` (absent when the plane isn't mounted) lets this handler
  // also record a memory entry for each persisted artifact (CL-5852).
  const artifactDeliveryHandlerDeps: Parameters<
    typeof createArtifactDeliveryHandler
  >[0] = {
    db,
    store: chatStore,
    roomMessages,
    publish: workbenchSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    claims: writeClaims,
    providerHealth: createProviderHealthPort(providerHealthStore),
    listConnectedProviders: (tenantId) => listConnectedProviders(db, tenantId),
  };
  if (memoryHandle !== undefined) {
    artifactDeliveryHandlerDeps.memory = memoryHandle.memory;
  }
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
  // `workbenchSubscribers` above, the same registry `createChatRoutes`
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
            publish: workbenchSubscribers.publish,
          },
          input,
        ),
    }),
  );

  // The one "is this a conversational agent?" ruling, shared by every
  // picker that offers agents to a person AND every taskability gate —
  // chat's invite/new-chat pickers, the task composer, and task-planner's
  // {use} target validation alike: automatable catalog workflows
  // (routines material) and workbench-host anchor definitions (chat's own
  // plumbing, never a person-facing agent) belong in neither.
  const isConversationalAgentDefinition = (definition: { name: string }) =>
    !isAutomatableWorkflowName(definition.name) &&
    !isWorkbenchHostDefinitionName(definition.name);

  // A second, narrower ruling layered on top of the taskability gate
  // above, for LISTING/PICKER surfaces only — never for taskability
  // itself. A planner-created agent (CL-6051's `{create}` branch, see
  // `@corbits/task-planner`'s `planner-created-naming.ts`) exists for
  // exactly one task; it must stay fully launchable (`spawnFromTaskSpec`
  // calls `launchTask` against the definition it just created) but must
  // never clutter a picker meant for agents a person deliberately keeps
  // around. Wired into every picker surface: chat's invite/new-chat
  // dialogs (`chatDeps.isInvitableDefinition` below) and the planner's
  // own inventory (`listMyraConversationalAgents` below) — the manual
  // task composer's picker (`apps/web`'s
  // `listTenantInvitableDefinitions`) calls the same chat route, so it
  // inherits this for free. `@corbits/agent-directory` has no listing
  // route of its own today (only create/read-skills/update-skills), so
  // there is no third surface to thread this through there yet.
  const isPickerListableDefinition = (definition: { name: string }) =>
    isConversationalAgentDefinition(definition) &&
    !isPlannerCreatedDefinitionName(definition.name);

  /** The address a principal's own message is posted under: their id at
   * their tenant's domain, the same shape every participant address
   * carries. */
  const senderAddressFor = async (
    tenantId: string,
    principalId: string,
  ): Promise<string> => {
    const row = await db.query.tenant.findFirst({
      where: eq(tenantTable.id, tenantId),
      columns: { domain: true },
    });
    if (row === undefined) {
      throw new Error(`No tenant "${tenantId}" to derive a sender address in`);
    }
    return `${principalId}@${row.domain}`;
  };

  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: chatStore,
    roomMessages,
    platform: chatPlatform,
    tenancy: chatTenancy,
    threads: threadStore,
    agentTurns,
    turnTextSnapshot: (input) =>
      createDrizzleTurnTextSnapshotReader(db).read(input),
    blockResponses: blockResponseStore,
    reactions: reactionStore,
    pins: pinStore,
    clientIds: createDrizzleClientIdStore(db),
    workbenchSubscribers,
    turnQueue,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    isInvitableDefinition: isPickerListableDefinition,
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    // Derived per tenant, per workbench creation, from that tenant's own
    // connected catalog providers (see `@corbits/chat`'s
    // `createWorkbenchHostInferencePreferencesResolver`) — never a fixed
    // provider/model pair, so a bench whose only credential is, say,
    // OpenRouter still gets a workbench host that can resolve a source.
    workbenchHostInferencePreferences:
      workbenchHostInferencePreferencesResolver,
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
    // from a workbench's participants releases its running instance the
    // same way, rather than leaving it deployed with nothing routing
    // messages to it.
    releaseAgentInstance: (address, reason) =>
      sidecarRouter.sendAgentUndeploy(address, reason),
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));
  // Myra's own workbench-invite surface (`@corbits/agent-directory-tools`'
  // `create_agent`'s `invite: true` default): the workflow-run-
  // authenticated counterpart to `POST .../invite` above, self-WORKBENCH
  // scoped — see `@corbits/chat`'s `workflow-participant-routes.ts` for
  // the [Intx/repo gap] this resolves around (no direct run-address ->
  // workbench index; resolved by scanning the tenant's workbench
  // participant lists).
  app.route(
    "/api/workflow-chat",
    createWorkflowParticipantRoutes({
      store: chatStore,
      platform: chatPlatform,
      roomMessages,
      publish: workbenchSubscribers.publish,
      turnQueue,
      authenticator: createWorkflowRunAuthenticator({ db }),
    }),
  );
  // Slack tag ingress (CL-5288 Phase 1): mounted OUTSIDE the tenant
  // prefix and outside session auth, like the webhook ingress below —
  // Slack is not a principal, and this route resolves its own
  // Interchange identity per message (see `./slack-tag-mount.ts` and
  // `@corbits/slack-tag`'s signature-verification-gated dispatch). A
  // missing SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET pair is a valid
  // configuration — the mount is silently skipped.
  const slackTagMount = await mountWorkbenchSlackTag({
    app,
    db,
    databaseUrl: config.databaseUrl,
    chatStore,
    chatPlatform,
    roomMessages,
    chatTenancy,
    workbenchSubscribers,
    turnQueue,
    workbenchHostInferencePreferences:
      chatDeps.workbenchHostInferencePreferences,
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
  });
  // Tells the routine trigger popover whether a Slack-bound webhook
  // trigger is honestly offerable in this deployment — no session or
  // tenant required to ask, the same reasoning as `/api/auth-config`
  // above. Only a boolean crosses this route, never the credential pair
  // itself.
  app.get("/api/deployment-capabilities", (c) =>
    c.json({ slackConfigured: slackTagMount.mounted }),
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
  // (see the vendored `onUsage` forward on `createEventCollectorRegistry`
  // above), since that's the only place tenantId/turnId/model land
  // together on an `inference.usage` event.
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
      // workspace parent's child workbenches (see resolveScope in
      // @corbits/insights' routes.ts).
      db,
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
  app.route(
    `${TENANT_PREFIX}/sidecar-placement`,
    createSidecarPlacementRoutes({
      store: createDrizzleSidecarPlacementStore(db),
      hasProvisioner: config.sidecarProvisioners.length > 0,
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

  // Agent definitions a person authors by hand from the Agents page's

  // create form, materialized the same way the platform's own starter
  // agents are (see `@corbits/agent-directory`'s doc comment). Shares
  // `chatGrantStore`/`chatConditionRegistry` with every other extension
  // mounted here — there is nothing chat-specific about that pair, it
  // is just this composition root's one db-backed grant store.
  // The skill registry over native `kind:"skill"` assets, plus the two
  // surfaces it serves: the tenant-session one the Skills settings
  // section calls, and the run-authenticated one a workflow child's
  // `@corbits/tools-skills` bundle calls (mounted outside the tenant
  // prefix below, beside `/api/workflow-memory`).
  const skills = mountSkills({
    db,
    assetService,
    repoStore: agentRepoStore.repoStore,
  });
  const definitionSkillsStore = createDrizzleDefinitionSkillsStore(db);
  app.route(
    `${TENANT_PREFIX}/skills`,
    createSkillRoutes({
      registry: skills.registry,
      pinnedBy: skills.pinnedBy,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  app.route(
    "/api/workflow-skills",
    createWorkflowSkillRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: skills.registry,
    }),
  );
  // The guided-capability-add fail-closed check reuses the exact same
  // listers `plannerInventorySources` (below) wires — `@corbits/agent-directory`
  // cannot import `@corbits/task-planner`'s `InventorySources`/`PlannerInventory`
  // types directly (task-planner already depends on agent-directory, so that
  // edge would cycle), but the tenant's live inventory of usable tool
  // packages, skills, and models is never assembled twice: both this
  // provider and the planner's own inventory read through the same
  // `listMyraUsableToolPackages`/`listMyraModels`/`skills.registry.list`
  // functions (declared further down this file, hoisted).
  const capabilityInventory: CapabilityInventoryProvider = {
    async resolve({ tenantId, principalId }) {
      const [toolPackages, tenantSkills, models] = await Promise.all([
        listMyraUsableToolPackages(tenantId),
        skills.registry.list({ tenantId, principalId }),
        listMyraModels(tenantId),
      ]);
      return {
        toolPackages: toolPackages.map((entry) => ({ name: entry.name })),
        skills: tenantSkills.map((entry) => ({ name: entry.name })),
        models: models.map((entry) => ({
          canonicalName: entry.canonicalName,
        })),
      };
    },
  };

  app.route(
    `${TENANT_PREFIX}/agent-definitions`,
    createAgentDefinitionRoutes({
      db,
      assetService,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      history: createDefinitionAssetHistory({
        repoStore: agentRepoStore.repoStore,
      }),
      capabilityInventory,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      // A definition created with no `model` still declares one — the
      // same tenant-catalog default a fresh workbench host resolves —
      // rather than staying empty and 409ing `not_launchable` at
      // invite time.
      tenantDefaultModel: async (tenantId) =>
        (await workbenchHostInferencePreferencesResolver(tenantId))[0]?.model,
    }),
  );
  // Myra's own agent-creation surface (`@corbits/agent-directory-tools`'
  // `create_agent`/`list_agents`): the workflow-run-authenticated
  // counterpart to the tenant-session mount just above, self-TENANT
  // scoped (Myra may create an agent anywhere in her own tenant). See
  // `@corbits/agent-directory`'s `workflow-create-routes.ts` for the
  // authorization reasoning.
  app.route(
    "/api/workflow-agent-directory",
    createWorkflowAgentCreateRoutes({
      db,
      assetService,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      capabilityInventory,
      authenticator: createWorkflowRunAuthenticator({ db }),
      tenantDefaultModel: async (tenantId) =>
        (await workbenchHostInferencePreferencesResolver(tenantId))[0]?.model,
    }),
  );
  // The workflow-run-authenticated variant of the capabilities route
  // just above (CL-6086): a workflow child has no browser session, only
  // its sidecar bearer token and its own run address, so it reaches
  // `POST /:definitionId/capabilities` through this surface instead,
  // mirroring `/api/workflow-skills`/`/api/workflow-memory`. See
  // `@corbits/agent-directory`'s `workflow-capability-routes.ts` for the
  // deliberate, documented authorization decision this route enforces
  // in place of a `requireGrant` check (CL-6085 tracks the durable fix).
  app.route(
    "/api/workflow-capabilities",
    createWorkflowCapabilityRoutes({
      db,
      assetService,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      capabilityInventory,
      authenticator: createWorkflowRunAuthenticator({ db }),
    }),
  );
  // Myra's own skill-pin surface (`@corbits/skills-tools`' `pin_skill`):
  // self-TENANT scoped (unlike `/api/workflow-capabilities` above, which
  // is self-definition scoped) — Myra may pin a skill onto any
  // definition in her own tenant. See `@corbits/agent-directory`'s
  // `workflow-skill-pin-routes.ts` for the authorization reasoning.
  app.route(
    "/api/workflow-skill-pins",
    createWorkflowSkillPinRoutes({
      db,
      assetService,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      authenticator: createWorkflowRunAuthenticator({ db }),
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
      workbenchBelongsToTenant: async (tenantId, workbenchId) =>
        (await chatStore.getWorkbenchSettings(tenantId, workbenchId)) !==
          undefined ||
        (await chatStore.hasLaunchedInstance(tenantId, workbenchId)),
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
  // Shared by every folded-run first-turn mail send below (webhook
  // triggers and routines alike) — a `CryptoProviderCache` is keyed by
  // instance id, which is globally unique across this hub regardless of
  // which caller minted the run, so one cache serves both without
  // collision risk.
  const foldedRunCryptoProviders = createCryptoProviderCache();
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
            assetService,
            sidecarRouter,
            eventCollectors,
            toolGrantsForPins,
            mcpCredentialBindingsFor,
            cryptoProviderCache: foldedRunCryptoProviders,
            launchMode: AGENT_SECTION_MODE,
            persistLaunch: workbenchLaunchPersistExtra,
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
      },
      providerHealth: providerHealthStore,
      listConnectedProviders: (tenantId) =>
        listConnectedProviders(db, tenantId),
    }),
  );
  // Connections' own OAuth connect flow (CL-6389): `createOAuthConnectRoutes`
  // (`@workbench/connections`) was exported but never mounted here — every
  // provider whose descriptor sets `oauth` (OpenRouter, Hugging Face, and
  // the GitHub App path) needs this to complete a one-click connect from
  // the settings surface above. Follows #115's `mcp-servers/oauth` mount
  // just below: state-param CSRF (real `state()` + exact-match callback
  // validation) lives entirely inside the factory; this mount only wires
  // the tenant already resolved by the platform's tenant middleware
  // through to `createTenantConnectCredential`.
  app.route(
    `${TENANT_PREFIX}/connections/oauth`,
    createOAuthConnectRoutes({
      hubUrl: config.baseUrl,
      log: (line) => log.info`${line}`,
      credentialCipher,
      // Same env bag `GET .../connections/oauth-configured` reads above.
      oauthEnv: {
        huggingfaceClientId: config.huggingfaceOAuthClientId,
        githubAppClientId: config.githubAppClientId,
        githubAppClientSecret: config.githubAppClientSecret,
      },
      connectCredential: createTenantConnectCredential({
        hubUrl: config.baseUrl,
        log: (line) => log.info`${line}`,
        providerHealth: providerHealthStore,
      }),
      defaultReturnPath: "/settings/connections",
      returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins"],
    }),
  );
  // GitHub connect card (CL-6344): the code-review template's inline
  // room card reads its live state and starts reviews through here.
  // Connecting the PAT itself stays on `connections` above (`github` is
  // already registered in `CONNECTOR_REGISTRY`) — this route only owns
  // what needs the decrypted secret, the live repo list, and a real
  // grant/webhook-trigger/settings write.
  app.route(
    `${TENANT_PREFIX}/workbenches`,
    createConnectGithubRoutes({
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      resolveGithubConfig: async (tenantId) => {
        const row = await resolveCredentialByName(db, tenantId, "GitHub");
        if (row === null) return undefined;
        const apiKey = await credentialCipher.decrypt(
          row.secret,
          credentialAad(row.id, "secret"),
        );
        return { apiKey };
      },
      resolveCodeReviewDefinitionId: async (tenantId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.name, "code-review"),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true },
        });
        return row?.id;
      },
      mintRepoGrant: async (tenantId, repo) => {
        const memberRole = await db.query.role.findFirst({
          where: and(
            eq(roleTable.tenantId, tenantId),
            eq(roleTable.name, "member"),
          ),
          columns: { id: true },
        });
        if (memberRole === undefined) {
          throw new Error(
            `tenant ${tenantId} has no system "member" role to scope a repo grant to`,
          );
        }
        const now = new Date();
        await db.insert(grantTable).values({
          id: generateId("grant"),
          tenantId,
          roleId: memberRole.id,
          resource: `repo:${repo.name}`,
          action: "read",
          effect: "allow",
          origin: "system",
          createdAt: now,
          updatedAt: now,
        });
      },
      createWebhookTrigger: async (
        tenantId,
        principalId,
        codeReviewDefinitionId,
        repo,
      ) => {
        const row = await webhookTriggerStore.create({
          id: generateId("workflowRun"),
          tenantId,
          name: `${repo.name} pull-request-opened`,
          workflowDefinitionId: codeReviewDefinitionId,
          inputTemplate: `Review the pull request at {{pull_request.html_url}}`,
          secret: generateWebhookSecret(),
          createdBy: principalId,
        });
        return { id: row.id };
      },
      getTemplateSettings: async (tenantId, workbenchId) => {
        const row = await chatStore.getWorkbenchSettings(tenantId, workbenchId);
        const settings = row?.settings ?? {};
        const pendingConnections = settings["template/pendingConnections"];
        const selectedRepos = settings["template/selectedRepos"];
        return {
          pendingConnections: Array.isArray(pendingConnections)
            ? (pendingConnections as string[])
            : [],
          selectedRepos: Array.isArray(selectedRepos)
            ? (selectedRepos as string[])
            : [],
        };
      },
      persistSelectedRepos: async (
        tenantId,
        workbenchId,
        principalId,
        patch,
      ) => {
        const existing = await chatStore.getWorkbenchSettings(
          tenantId,
          workbenchId,
        );
        const row = await chatStore.updateWorkbenchSettings({
          tenantId,
          workbenchId,
          settings: { ...(existing?.settings ?? {}), ...patch },
          updatedBy: principalId,
        });
        workbenchSubscribers.publish(workbenchId, {
          type: "chat.settings",
          data: { updatedBy: principalId, settings: row.settings },
        });
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
      listConnectedProviders: (tenantId) =>
        listConnectedProviders(db, tenantId),
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
  // Notify-to-reconnect for an OAuth-connected credential whose token
  // expired (Hugging Face today — see docs/onboarding-huggingface-connect.md):
  // a light periodic sweep over `@corbits/notify`'s pure
  // `findDueCredentialExpiries`, mailing through the same delivery
  // adapter above. `createInMemoryNotifyDispatchStore`/`createSinkRegistry()`
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
    notify: {
      mail: mailboxDelivery,
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.${notifyHost}`,
        from: (kind) => `${kind}@notify.${notifyHost}`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
  });

  // Spawn-and-return agent tasks (`@corbits/tasks`, CL-6049): a prompt
  // plus an agent definition launches a one-shot folded run with no
  // workbench, and its finalized reply lands in the Inbox through the
  // same notify delivery adapter `credentialExpirySweep` uses above.
  // Own idle-sleep-and-UNDEPLOY lifecycle instance (the same
  // `@corbits/agent-lifecycle` package chat's platform adapter used to
  // drive before CL-5477 retired that binding) — kept here, unlike
  // chat's, because `wake` is never actually called: a task's run only
  // ever needs waking to deliver a follow-up message, and a one-shot task
  // never sends one after its opening prompt. There is no run left to
  // lose by undeploying once one goes idle, so this sweep's undeploy is
  // genuine cleanup, not the lossy "kill what the wake path cannot
  // revive" failure mode chat's own lifecycle had.
  const taskStore = createDrizzleTaskStore(db);
  const taskLifecycle = createAgentLifecycle({
    idleSleepMs: TASK_IDLE_UNDEPLOY_MS,
    isRoutable: (address) =>
      sidecarRouter.getRoutableAddresses().includes(address),
    undeploy: (address, reason) =>
      sidecarRouter.sendAgentUndeploy(address, reason),
    wake: () => {
      throw new Error(
        "a task-launched run is never woken after its opening prompt",
      );
    },
    isBusy: (address) =>
      typeof eventCollectors.getCurrentTurnId(address) === "string",
    log: getLogger(["tasks", "lifecycle"]),
  });
  const taskNotifyDeps = {
    mail: mailboxDelivery,
    addressing: {
      inbox: (recipient: { principalId: string }) =>
        `${recipient.principalId}@inbox.${notifyHost}`,
      from: (kind: string) => `${kind}@notify.${notifyHost}`,
    },
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
  const taskLauncherDeps = {
    db,
    store: taskStore,
    foldedRuns: {
      db,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
      credentialCipher,
      hubPublicKey,
      toolGrantsForPins,
      mcpCredentialBindingsFor,
    },
    cryptoProviders: createCryptoProviderCache(),
    notify: taskNotifyDeps,
    isTaskableDefinition: isConversationalAgentDefinition,
    lifecycle: taskLifecycle,
  };
  const taskOrchestrator = createTaskOrchestrator({
    db,
    store: taskStore,
    events: sidecarRouter.events,
    notify: taskNotifyDeps,
    recordActivity: (address) => taskLifecycle.recordActivity(address),
    launchLeg: (input) => launchTaskLeg(taskLauncherDeps, input),
    workbench: {
      async post({ tenantId, workbenchId, text }) {
        await chatPlatform.sendMail({
          tenantId,
          workbenchId,
          fromWorkbenchId: workbenchId,
          content: { content: text },
        });
      },
      async resolveFallbackWorkbenchId(tenantId) {
        try {
          const myraDefinitionId = await resolveMyraDefinitionIdFromDb(
            db,
            tenantId,
          );
          const chat = await findExistingAgentChat(
            { store: chatStore, platform: chatPlatform, tenancy: chatTenancy },
            tenantId,
            myraDefinitionId,
          );
          return chat?.workbenchId;
        } catch {
          return undefined;
        }
      },
    },
  });
  // A hand-off claimed by a process that died has no one left to
  // redeliver it, so a periodic pass gives up on it and tells the
  // person — same shape `credentialExpirySweep` above uses.
  const stuckLegSweep = createStuckLegSweep({
    db,
    store: taskStore,
    notify: taskNotifyDeps,
  });
  const chatFinalizedTurnHandler = artifactDeliveryHandlerRef.current;
  artifactDeliveryHandlerRef.current = (agentAddress, turn) => {
    chatFinalizedTurnHandler?.(agentAddress, turn);
    taskOrchestrator.handleFinalizedTurn(agentAddress, turn);
  };
  app.route(
    `${TENANT_PREFIX}/tasks`,
    createTaskRoutes({
      store: taskStore,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      launch: (input) => launchTask(taskLauncherDeps, input),
    }),
  );

  // Every genuine top-level deployment run, folded runs (workbench hosts,
  // invited agents, tasks) excluded — the scoped listing CL-6061 adds
  // so the Agent Directory and the shell's "Running" bands stop
  // deriving that exclusion client-side from a tenant's workbenches alone
  // (see `@corbits/folded-runs`'s `scope-routes.ts`, which task-style
  // runs — no workbench involved — silently slipped past). The route's
  // `feed=fires` mode (Insights, CL-6249) needs the one bridge
  // `@corbits/folded-runs` cannot own itself — resolving a folded run id
  // back to the routine that fired it — wired here, the one place in
  // the hub that already depends on both packages. Plain `db` queries
  // against `@corbits/routines`' own tables, not its `RoutineStore`:
  // that store does not exist yet at this point in composition (built
  // just below, for the routine grant/launcher wiring), and this lookup
  // needs nothing from it beyond the two tables.
  async function resolveRoutineFires(runIds: readonly string[]) {
    const rows = await db
      .select({
        runId: routineRunTable.runId,
        routineId: routineRunTable.routineId,
        routineName: routineTable.name,
      })
      .from(routineRunTable)
      .innerJoin(routineTable, eq(routineTable.id, routineRunTable.routineId))
      .where(inArray(routineRunTable.runId, runIds));
    const fires = new Map<string, { routineId: string; routineName: string }>();
    for (const row of rows) {
      fires.set(row.runId, {
        routineId: row.routineId,
        routineName: row.routineName,
      });
    }
    return fires;
  }
  app.route(
    `${TENANT_PREFIX}/top-level-runs`,
    createTopLevelRunRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      resolveRoutineFires,
    }),
  );

  // Routines: its own grant store (routines authorize against the
  // `workflow-run:*` resource family, the same one native run routes
  // use — see `@corbits/routines`' routes.ts), the launcher adapter
  // that turns a routine's `launchRoutineRun` call into a real folded
  // run via `@corbits/folded-runs` (routine-launcher.ts), and a run
  // summary resolver so `GET /routines/:id/runs` reports each fire's
  // real status instead of a bare run id. Constructed after
  // `taskLauncherDeps` above (not alongside chat/connections earlier)
  // because its `dispatchTask` port needs that object to exist first —
  // see routine-launcher.ts's own doc for why a routine ever calls
  // `launchTask` at all.
  const routineGrantStore = createGrantStore(db);
  const routineStore = createDrizzleRoutineStore(db);
  const routineDraftStore = createDrizzleDraftStore(db);
  // The honest end-to-end delivery-destination rule: a workflow that
  // never posts to a workbench (e.g. recurring-task, always delivering
  // to its creator's Inbox — see @corbits/workflow-catalog's
  // `deliveryMode`) must never be forced to collect, or block on
  // missing, a `deliveryWorkbenchId` it would just discard. An unknown
  // definitionId (row missing, or its asset name isn't catalog-known)
  // defaults to workbench-required — the safe, prior behavior.
  async function routineDeliveryWorkbenchRequired(
    tenantId: string,
    definitionId: string,
  ): Promise<boolean> {
    const row = await db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, definitionId),
        eq(workflowDefinition.tenantId, tenantId),
      ),
      columns: { name: true },
    });
    if (row === undefined) return true;
    return deliveryWorkbenchRequiredForWorkflowName(row.name);
  }
  // Create-time boundary check for a routine's stored `input` against
  // its own definition's declared trigger fields. CL-6358: inputs bind
  // at USE, never at creation — a required field with no value at all
  // is never rejected here (`validateTriggerFieldsAtCreate` only
  // checks a value the caller actually provided), only resolved
  // further for an `"agent"`-kind field — that a provided value names
  // a real taskable definition. An unknown definitionId or asset name
  // passes here (its 404 comes from `definitionInTenant` instead); a
  // definition with no declared trigger fields accepts any input, same
  // as today. `launchTask`'s own definition checks at fire time remain
  // the authoritative required-field gate.
  async function routineInputValid(
    tenantId: string,
    definitionId: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const row = await db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, definitionId),
        eq(workflowDefinition.tenantId, tenantId),
      ),
      columns: { name: true },
    });
    if (row === undefined) return { ok: true };
    const entry = workflowCatalogEntry(row.name);
    if (entry?.triggerFields === undefined) return { ok: true };

    const shapeResult = validateTriggerFieldsAtCreate(
      entry.triggerFields,
      input,
    );
    if (!shapeResult.ok) return shapeResult;

    for (const field of entry.triggerFields) {
      if (field.kind !== "agent") continue;
      const value = input[field.key];
      if (typeof value !== "string" || value === "") continue;
      const agentRow = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, value),
          eq(workflowDefinition.tenantId, tenantId),
        ),
        columns: { name: true, status: true },
      });
      if (
        agentRow === undefined ||
        agentRow.status !== "deployed" ||
        !isConversationalAgentDefinition(agentRow)
      ) {
        return {
          ok: false,
          message: `"${field.label}" must be a taskable agent`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * The routine-drafting inventory's workflow half: every deployed
   * definition in the tenant whose catalog entry is `automatable`,
   * carrying the exact `triggerFields`/`deliveryMode` Myra's drafted
   * trigger input is checked against (`@corbits/routines`'
   * `validateRoutineDraftReplyAgainstInventory`). Mirrors
   * `listMyraConversationalAgents` below in shape, scoped to
   * automatable rather than conversational definitions.
   */
  async function listAutomatableWorkflowsForDraftInventory(
    tenantId: string,
  ): Promise<readonly RoutineDraftInventoryWorkflow[]> {
    const rows = await db.query.workflowDefinition.findMany({
      where: and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.status, "deployed"),
      ),
    });
    const out: RoutineDraftInventoryWorkflow[] = [];
    for (const row of rows) {
      if (!isAutomatableWorkflowName(row.name)) continue;
      const entry = workflowCatalogEntry(row.name);
      if (entry === undefined) continue;
      const workflow = {
        definitionId: row.id,
        assetName: row.name,
        displayName: workflowDisplayName(row.name, row.description),
        deliveryMode: entry.deliveryMode,
        triggerFields: entry.triggerFields ?? [],
      };
      out.push(
        row.description !== null
          ? { ...workflow, description: row.description }
          : workflow,
      );
    }
    return out;
  }

  // A separate `CryptoProviderCache` from the task launcher's and the
  // planner's own (`plannerCryptoProviders` below): a routine-drafting
  // one-shot run's instance id has nothing to do with either lifecycle,
  // so a separate cache keeps the three from ever contending over the
  // same key space — same rationale as `plannerCryptoProviders`' own
  // comment.
  const routineDraftingCryptoProviders = createCryptoProviderCache();

  const routineLauncher = createHubRoutineLauncher({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    credentialCipher,
    toolGrantsForPins,
    mcpCredentialBindingsFor,
    cryptoProviderCache: foldedRunCryptoProviders,
    dispatchTask: (input) => launchTask(taskLauncherDeps, input),
    joinDeliveryWorkbench: (input) =>
      joinRunParticipant({ store: chatStore }, input),
  });
  const routineWorkbenchNotice = {
    postWorkbenchNotice: (input: {
      tenantId: string;
      workbenchId: string;
      principalId: string;
      text: string;
    }) =>
      senderAddressFor(input.tenantId, input.principalId)
        .then((senderAddress) =>
          sendWorkbenchMessage(
            {
              store: chatStore,
              platform: chatPlatform,
              roomMessages,
              publish: workbenchSubscribers.publish,
              turnQueue,
            },
            {
              tenantId: input.tenantId,
              principalId: input.principalId,
              senderAddress,
              workbenchId: input.workbenchId,
              messageParts: [{ kind: "text", text: input.text }],
            },
          ),
        )
        .then(() => undefined),
  };
  // Routines routes own their `/routines` and `/routine-drafts` prefixes, so
  // mount at the tenant root (same pattern as a package that ships absolute
  // resource paths) rather than under a second `/routines` segment.
  app.route(
    TENANT_PREFIX,
    createRoutineRoutes({
      store: routineStore,
      drafts: routineDraftStore,
      workbenchNotice: routineWorkbenchNotice,
      // Myra-backed drafting (CL-5917): a real one-shot inference call,
      // mirroring `@corbits/task-planner`'s own Myra auto-dispatch
      // wiring below (`plannerInventorySources`/`dispatchWithPlanner`)
      // — resolve Myra's definition, offer her the automatable-workflow
      // and taskable-agent inventory, and never trust her reply beyond
      // what `@corbits/routines`' own fail-closed validation proves.
      drafting: createMyraRoutineDrafting({
        resolveMyraDefinitionId: (tenantId) =>
          resolveMyraDefinitionIdFromDb(db, tenantId),
        runner: {
          run: (runnerInput) =>
            runOneShotFoldedPrompt(
              {
                foldedRuns: taskLauncherDeps.foldedRuns,
                events: sidecarRouter.events,
                cryptoProviders: routineDraftingCryptoProviders,
                lifecycle: taskLifecycle,
                undeploy: (address, reason) =>
                  sidecarRouter.sendAgentUndeploy(address, reason),
              },
              runnerInput,
            ),
        },
        inventorySources: {
          listAutomatableWorkflows: listAutomatableWorkflowsForDraftInventory,
          listTaskableAgents: listMyraConversationalAgents,
        },
      }),
      launcher: routineLauncher,
      requireGrant: createRequireGrant({
        grantStore: routineGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      // A run-now or a scheduled fire's result is a message into the
      // routine's delivery workbench root timeline — never a pre-opened
      // thread; see `@corbits/routines`' `RoutineLauncher` doc comment
      // for the multi-message contract.
      runSummaryResolver: createHubRunSummaryResolver(db),
      definitionInTenant: async (tenantId, definitionId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
          columns: { id: true },
        });
        return row !== undefined;
      },
      // A `{kind: "webhook"}` trigger's `webhookTriggerId` must resolve
      // to a real `webhook_trigger` row in this tenant, pointed at the
      // exact same workflow definition the routine itself runs — see
      // `webhookTriggerValid`'s doc comment in
      // `@corbits/routines`' routes.ts for why the two ids must agree.
      webhookTriggerInTenant: async (
        tenantId,
        webhookTriggerId,
        definitionId,
      ) => {
        const row = await webhookTriggerStore.get(tenantId, webhookTriggerId);
        return row !== undefined && row.workflowDefinitionId === definitionId;
      },
      deliveryWorkbenchRequired: routineDeliveryWorkbenchRequired,
      // A routine created with no `deliveryWorkbenchId` gets a brand-new
      // space of its own, named after it, rather than a dead-end
      // 400 — the same workbench-provisioning core `POST /chat/workbenches`
      // uses (`@corbits/chat`'s `provisionSpaceWorkbench`), reused here
      // instead of reimplemented.
      deliverySpace: {
        createDeliverySpace: (input) =>
          provisionSpaceWorkbench(
            {
              tenancy: chatTenancy,
              platform: chatPlatform,
              store: chatStore,
              workbenchHostInferencePreferences:
                chatDeps.workbenchHostInferencePreferences,
              turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
            },
            input,
          ),
      },
      validateRoutineInput: routineInputValid,
    }),
  );
  // Myra's own routine-management surface (`@corbits/routines-tools`'
  // `routine_list`/`routine_create`/`routine_update`/`routine_run_now`):
  // the workflow-run-authenticated counterpart to the tenant-session
  // mount just above, reusing the exact same store/launcher/delivery
  // ports — see `@corbits/routines`' `workflow-routine-routes.ts` for
  // the deliberate self-tenant-scoped authorization decision this route
  // enforces in place of `requireGrant`.
  app.route(
    "/api/workflow-routines",
    createWorkflowRoutineRoutes({
      store: routineStore,
      launcher: routineLauncher,
      workbenchNotice: routineWorkbenchNotice,
      authenticator: createWorkflowRunAuthenticator({ db }),
      definitionInTenant: async (tenantId, definitionId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
          columns: { id: true },
        });
        return row !== undefined;
      },
      // Myra's `routine_create` tool receives a definition's NAME from
      // `list_agents`, not its `wfd_` id — resolve an exact, deployed-only
      // name match within the tenant before the `definitionInTenant`
      // check above runs a second time against the resolved id.
      resolveDefinitionId: async (tenantId, idOrName) => {
        const rows = await db.query.workflowDefinition.findMany({
          where: and(
            eq(workflowDefinition.name, idOrName),
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true },
        });
        return rows.length === 1 ? rows[0]?.id : undefined;
      },
      listDefinitionCandidates: async (tenantId) => {
        const rows = await db.query.workflowDefinition.findMany({
          where: and(
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true, name: true },
          limit: 8,
        });
        return rows;
      },
      webhookTriggerInTenant: async (
        tenantId,
        webhookTriggerId,
        definitionId,
      ) => {
        const row = await webhookTriggerStore.get(tenantId, webhookTriggerId);
        return row !== undefined && row.workflowDefinitionId === definitionId;
      },
      deliveryWorkbenchRequired: routineDeliveryWorkbenchRequired,
      // A routine created from inside a workbench delivers into that
      // workbench: the creating run is a workbench participant, so its
      // address (runId@domain) resolves straight to the workbench.
      resolveRunWorkbench: async (tenantId, runId) => {
        const row = await db.query.tenant.findFirst({
          where: eq(tenantTable.id, tenantId),
          columns: { domain: true },
        });
        if (row === undefined) return undefined;
        const hit = await chatStore.findWorkbenchByParticipantAddress(
          tenantId,
          `${runId}@${row.domain}`,
        );
        return hit?.workbenchId;
      },
      deliverySpace: {
        createDeliverySpace: (input) =>
          provisionSpaceWorkbench(
            {
              tenancy: chatTenancy,
              platform: chatPlatform,
              store: chatStore,
              workbenchHostInferencePreferences:
                chatDeps.workbenchHostInferencePreferences,
              turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
            },
            input,
          ),
      },
      resolveTenantDomain: async (tenantId) => {
        const row = await db.query.tenant.findFirst({
          where: eq(tenantTable.id, tenantId),
          columns: { domain: true },
        });
        if (row === undefined) {
          throw new Error(`No tenant "${tenantId}"`);
        }
        return row.domain;
      },
      validateRoutineInput: routineInputValid,
    }),
  );
  // Recurring auto-fire: a minimal in-process poller (routine-scheduler.ts)
  // over `@corbits/routines`' own `fireScheduledRoutine` — this hub has no
  // general job-runner today, so this loop is scoped to exactly one job
  // (fire due routines) rather than standing up a bespoke cron daemon as a
  // hidden dependency. Every hub replica can safely run this poller: each
  // fire is claimed with a conditional update on the routine's persisted
  // `nextFireAt` before anything launches, so two replicas racing the same
  // fire never both win, and a fire that falls due while every replica is
  // down is caught up (not lost) the next time any of them polls.
  const routineScheduler = createRoutineScheduler({
    store: routineStore,
    launcher: routineLauncher,
    deliveryWorkbenchRequired: routineDeliveryWorkbenchRequired,
  });

  // Myra auto-dispatch (CL-6051): a typed outcome becomes a validated
  // task plan via `@corbits/task-planner`, dispatched exactly like a
  // manually-launched task. Every inventory lister below generalizes a
  // pattern that already lives elsewhere in this composition root
  // (`isConversationalAgentDefinition`, `chatDeps.workbenchHostInferencePreferences`'s
  // per-tenant connected-provider derivation) — this package owns the
  // inventory's shape, never the listing logic.
  const memoryToolPackageName = "@corbits/memory-tools";
  // `@corbits/capability-tools` (CL-6084/CL-6086)'s `request_capability`
  // tool needs no per-tenant credential either, like memory-tools: the
  // sidecar now threads its own `definitionId` into a step's tool env
  // (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`), and
  // `/api/workflow-capabilities` (mounted below) gives it a
  // workflow-run-authenticated path to the capabilities route the same
  // way `/api/workflow-skills` and `/api/workflow-memory` do. Both gaps
  // that used to keep it out of this lister are closed.
  const capabilityToolPackageName = "@corbits/capability-tools";

  async function listMyraConversationalAgents(
    tenantId: string,
  ): Promise<readonly InventoryAgent[]> {
    const rows = await db.query.workflowDefinition.findMany({
      where: and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.status, "deployed"),
      ),
    });
    return rows
      .filter((row) => isPickerListableDefinition(row))
      .map((row) => {
        const agent = {
          id: row.id,
          name: row.name,
          displayName: workflowDisplayName(row.name, row.description),
        };
        if (row.description !== null) {
          return { ...agent, description: row.description };
        }
        return agent;
      });
  }

  async function listMyraUsableToolPackages(
    tenantId: string,
  ): Promise<readonly InventoryToolPackage[]> {
    const connectedConnectorIds = await listConnectedProviders(db, tenantId);
    const entries: InventoryToolPackage[] = [];
    for (const connectorId of connectedConnectorIds) {
      const descriptor = CONNECTOR_REGISTRY[connectorId];
      if (descriptor === undefined) continue;
      for (const toolPackageName of descriptor.feedsTools) {
        // This listing is already scoped to connections registry ∩
        // tenant credentials that exist (`listConnectedProviders`), so
        // every entry it returns necessarily has a live credential —
        // the binding mirrors `workflows/granola-call`'s
        // `GRANOLA_CALL_CREDENTIAL_BINDINGS` exactly: `handle`/`provider`
        // both equal the connector id.
        entries.push({
          name: toolPackageName,
          connectorId: descriptor.id,
          credentialBinding: {
            package: toolPackageName,
            handle: descriptor.id,
            provider: descriptor.id,
            locator: "tenant",
          },
        });
      }
    }
    if (memoryHandle !== undefined) {
      entries.push({
        name: memoryToolPackageName,
        connectorId: "memory",
        credentialBinding: null,
      });
    }
    entries.push({
      name: capabilityToolPackageName,
      connectorId: "capability",
      credentialBinding: null,
    });
    // MCP tools are fed by MCP server connections, not by the classic
    // connector registry above — without this the inventory rejects
    // `@corbits/mcp-tools` on a bench with live MCP servers, so created
    // specialists cannot search (CL-6206's live 400). Credential
    // bindings for this package come from `mcpCredentialBindingsFor`
    // at launch, never from an inventory row.
    const mcpServers = await listMcpServerConnections(db, tenantId);
    if (mcpServers.length > 0) {
      entries.push({
        name: "@corbits/mcp-tools",
        connectorId: "mcp",
        credentialBinding: null,
      });
    }
    // The ask_user interaction card needs no credential at all — it is
    // always offerable, exactly like capability-tools.
    entries.push({
      name: "@corbits/interaction-tools",
      connectorId: "interaction",
      credentialBinding: null,
    });
    return entries;
  }

  async function listMyraModels(
    tenantId: string,
  ): Promise<readonly InventoryModel[]> {
    const rows = await db.query.model.findMany({
      where: and(eq(model.tenantId, tenantId), eq(model.disabled, false)),
    });
    return rows.map((row) => {
      const entry = { canonicalName: row.canonicalName };
      if (row.displayName !== null) {
        return { ...entry, displayName: row.displayName };
      }
      return entry;
    });
  }

  const plannerInventorySources: InventorySources = {
    listConversationalAgents: listMyraConversationalAgents,
    listUsableToolPackages: listMyraUsableToolPackages,
    listSkills: (caller) => skills.registry.list(caller),
    memoryAvailable: memoryHandle !== undefined,
    listModels: listMyraModels,
  };

  /**
   * Wraps the same sequence `@corbits/agent-directory`'s `POST /`
   * handler runs (`buildAgentDefinitionWorkflow` → `reindexPinnedSkills`
   * when skills are present → `createAsset` + `populateAsset` →
   * `ensureWorkflowDefinitionForAsset`), reusing the exact `db`,
   * `assetService`, and `skills.skillIndex` already in scope — never a
   * second instance of any of them. The one addition beyond that route's
   * own input is `toolPackagePins`, which the REST boundary deliberately
   * has no field for (see `@corbits/agent-directory`'s `validation.ts`)
   * since only this in-process planner caller needs it.
   */
  async function deployAgentDefinition(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly handle: string;
    readonly systemPrompt: string;
    readonly toolPackagePins: readonly string[];
    readonly skills: readonly string[];
    readonly credentialBindings: readonly CredentialBinding[];
    readonly model?: string;
  }): Promise<{ readonly definitionId: string }> {
    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenantTable.id, input.tenantId),
    });
    if (tenantRow === undefined) {
      throw new Error(`No tenant "${input.tenantId}"`);
    }

    const handle = input.handle;
    const skillEntries =
      input.skills.length > 0
        ? await skills.skillIndex.resolve(
            input.tenantId,
            input.principalId,
            input.skills,
          )
        : [];

    type MutableBuildAgentDefinitionInput = {
      -readonly [
        K in keyof Parameters<typeof buildAgentDefinitionWorkflow>[0]
      ]: Parameters<typeof buildAgentDefinitionWorkflow>[0][K];
    };
    const buildInput: MutableBuildAgentDefinitionInput = {
      handle,
      tenantDomain: tenantRow.domain,
      description: "",
      systemPrompt: input.systemPrompt,
    };
    if (input.model !== undefined) {
      buildInput.model = input.model;
    }
    if (input.toolPackagePins.length > 0) {
      buildInput.toolPackagePins = input.toolPackagePins.map((name) => ({
        name,
        version: "*",
      }));
    }
    if (input.credentialBindings.length > 0) {
      buildInput.credentialBindings = input.credentialBindings;
    }
    const definition = buildAgentDefinitionWorkflow(buildInput);
    const workflowJson = reindexPinnedSkills(
      serializeAgentDefinitionWorkflow(definition),
      skillEntries,
    );

    const created = await assetService.createAsset({
      tenantId: input.tenantId,
      kind: "workflow",
      name: handle,
      displayName: input.name,
      creatorPrincipalId: input.principalId,
    });

    await assetService.populateAsset({
      assetId: created.id,
      ref: DEFAULT_ASSET_REF,
      principal: { kind: "hub" },
      tree: {
        files: agentDefinitionSourceTree({ handle, workflowJson }),
        message: `Define agent ${input.name}`,
      },
    });
    await definitionSkillsStore.setSkills(created.id, input.skills);

    const wireHash = await computeWireDefinitionHash(JSON.parse(workflowJson));
    const { definitionId } = await ensureWorkflowDefinitionForAsset(db, {
      assetId: created.id,
      wireHash,
    });
    return { definitionId };
  }

  /**
   * A chain spawn's cleanup half: flips a definition `deployAgentDefinition`
   * just deployed to `workflowDefinition`'s own `"stopped"` status, so a
   * step later in the same chain failing to validate or deploy never
   * leaves an orphaned agent nothing will ever launch. Scoped to
   * `tenantId` + `definitionId` like every other definition write in
   * this file; no asset/materialization cleanup, since a `"stopped"`
   * definition is already excluded from every launch/taskability path
   * `deployAgentDefinition` itself feeds.
   */
  async function undeployAgentDefinition(input: {
    readonly tenantId: string;
    readonly definitionId: string;
  }): Promise<void> {
    await db
      .update(workflowDefinition)
      .set({ status: "stopped" })
      .where(
        and(
          eq(workflowDefinition.tenantId, input.tenantId),
          eq(workflowDefinition.id, input.definitionId),
        ),
      );
  }

  // A separate `CryptoProviderCache` from the task launcher's own
  // (`taskLauncherDeps.cryptoProviders`): a planning run's instance id
  // is never a real task's, but the cache is keyed by instance id
  // regardless, and a planning run's one-shot prompt/reply cadence has
  // nothing to do with a launched task's — separate caches keep the
  // two lifecycles from ever contending over the same key space.
  const plannerCryptoProviders = createCryptoProviderCache();

  // A separate `CryptoProviderCache` again from `plannerCryptoProviders`
  // — an agent-definition drafting one-shot run's instance id has
  // nothing to do with either lifecycle, same rationale as
  // `routineDraftingCryptoProviders`' own comment above.
  const agentDefinitionDraftingCryptoProviders = createCryptoProviderCache();

  app.route(
    `${TENANT_PREFIX}/planner`,
    createPlannerRoutes({
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      dispatch: (input) =>
        dispatchWithPlanner(
          {
            db,
            runner: {
              run: (runnerInput) =>
                runOneShotFoldedPrompt(
                  {
                    foldedRuns: taskLauncherDeps.foldedRuns,
                    events: sidecarRouter.events,
                    cryptoProviders: plannerCryptoProviders,
                    // Reuses `taskLifecycle` rather than standing up a
                    // second idle-sleep instance: it's keyed entirely by
                    // address, and a planner run's `triggerAddress`
                    // (`formatRunAddress` over a freshly generated
                    // `workflowRun` instance id) can never collide with a
                    // task's — sharing costs nothing and keeps one sweep
                    // instead of two.
                    lifecycle: taskLifecycle,
                    undeploy: (address, reason) =>
                      sidecarRouter.sendAgentUndeploy(address, reason),
                  },
                  runnerInput,
                ),
            },
            inventorySources: plannerInventorySources,
            resolveMyraDefinitionId: (tenantId) =>
              resolveMyraDefinitionIdFromDb(db, tenantId),
            taskLauncherDeps,
            store: taskStore,
            deployAgentDefinition,
            undeployAgentDefinition,
            // The `{create}` branch's own grant, checked deep inside
            // `dispatch` rather than at route-middleware time — the
            // definitional plan (`{use}` vs `{create}`) is only known
            // after Myra's reply resolves. Same `chatGrantStore`/
            // `chatConditionRegistry` every other `requireGrant` call
            // site in this file uses, called through `authorize`
            // directly (the standalone, non-middleware primitive
            // `createRequireGrant`'s own middleware wraps) since this
            // is not a route boundary.
            requireDefinitionCreateGrant: async ({ tenantId, principalId }) => {
              const result = await authorize(
                chatGrantStore,
                principalId,
                tenantId,
                "workflow-definition:*",
                "create",
                chatConditionRegistry,
              );
              if (result.effect !== "allow") {
                throw new PlannerDefinitionGrantDeniedError(principalId);
              }
            },
          },
          input,
        ),
      // Agent-definition drafting (CL-6074): the create-agent panel's
      // "Create & chat" flow asks Myra for a starting system prompt from
      // a name + plain-language purpose, mirroring the routine-drafting
      // wiring above — resolve Myra's definition, offer her the same
      // inventory the planner itself uses, and never trust her reply
      // beyond what `@corbits/task-planner`'s own fail-closed validation
      // proves. Never deploys on its own; the panel submits the
      // validated draft through the ordinary create-agent-definition
      // path once the person confirms.
      draftAgentDefinition: (input) =>
        createMyraAgentDefinitionDrafting({
          resolveMyraDefinitionId: (tenantId) =>
            resolveMyraDefinitionIdFromDb(db, tenantId),
          runner: {
            run: (runnerInput) =>
              runOneShotFoldedPrompt(
                {
                  foldedRuns: taskLauncherDeps.foldedRuns,
                  events: sidecarRouter.events,
                  cryptoProviders: agentDefinitionDraftingCryptoProviders,
                  lifecycle: taskLifecycle,
                  undeploy: (address, reason) =>
                    sidecarRouter.sendAgentUndeploy(address, reason),
                },
                runnerInput,
              ),
          },
          inventorySources: plannerInventorySources,
        }).propose(input),
    }),
  );
  // Myra's own task-dispatch surface (`@corbits/task-dispatch-tools`'
  // `dispatch_task`): the workflow-run-authenticated counterpart to the
  // tenant-session planner route just above, reusing the exact same
  // spawn/planner deps. When the tool call names an `agentDefinitionId`
  // it skips the planner's own one-shot re-ask entirely (see
  // `@corbits/task-planner`'s `workflow-dispatch-routes.ts`); otherwise
  // it falls back to the full Myra-picks-or-creates-an-agent flow.
  app.route(
    "/api/workflow-task-planner",
    createWorkflowDispatchRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      db,
      runner: {
        run: (runnerInput) =>
          runOneShotFoldedPrompt(
            {
              foldedRuns: taskLauncherDeps.foldedRuns,
              events: sidecarRouter.events,
              cryptoProviders: plannerCryptoProviders,
              lifecycle: taskLifecycle,
              undeploy: (address, reason) =>
                sidecarRouter.sendAgentUndeploy(address, reason),
            },
            runnerInput,
          ),
      },
      inventorySources: plannerInventorySources,
      resolveMyraDefinitionId: (tenantId) =>
        resolveMyraDefinitionIdFromDb(db, tenantId),
      taskLauncherDeps,
      store: taskStore,
      chatStore,
      deployAgentDefinition,
      undeployAgentDefinition,
      requireDefinitionCreateGrant: async ({ tenantId, principalId }) => {
        const result = await authorize(
          chatGrantStore,
          principalId,
          tenantId,
          "workflow-definition:*",
          "create",
          chatConditionRegistry,
        );
        if (result.effect !== "allow") {
          throw new PlannerDefinitionGrantDeniedError(principalId);
        }
      },
    }),
  );

  // The sanctioned path for a workflow run to reach the memory plane
  // (CL-5852), mirroring `/api/workflow-artifacts` immediately above:
  // mounted OUTSIDE `TENANT_PREFIX` since a workflow-process child has
  // no browser session, every request authenticates via the same
  // `WorkflowRunAuthenticator` (sidecar bearer token + run address)
  // against this hub's own control-plane `db`. Serves through
  // `memoryHandle.memory` — the SAME in-process plane instance
  // `mountMemory` mounted above, never a second connection.
  if (memoryHandle !== undefined) {
    app.route(
      "/api/workflow-memory",
      createWorkflowMemoryRoutes({
        authenticator: createWorkflowRunAuthenticator({ db }),
        store: createWorkflowMemoryStore(memoryHandle.memory),
      }),
    );
  } else {
    app.route("/api/workflow-memory", createUnavailableWorkflowMemoryRoutes());
  }

  // Closed-by-default access policy: a per-tenant policy row layered
  // over native tenancy/RBAC (see `@workbench/access-policy`). Migrated
  // at hub start like insights/preferences/bench-settings; mounted
  // tenant-scoped for the settings panel, and threaded into the
  // onboarding hook below so first-login provisioning honors it without
  // patching any vendor route.
  await applyAccessPolicyMigrations(config.databaseUrl);
  const accessPolicyStore = createDrizzleAccessPolicyStore(db);
  const selfApi = createHubAPI(config.baseUrl);
  app.route(
    `${TENANT_PREFIX}/access-policy`,
    createAccessPolicyRoutes({
      store: accessPolicyStore,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      api: selfApi,
    }),
  );

  // The first-login hook mounts outside the tenant prefix, since the
  // session it serves belongs to no tenant yet. The route is
  // `@workbench/onboarding`'s; what it decides is documented in that
  // package's provision.ts.
  const onboardingDeps: Parameters<typeof createOnboardingRoutes>[0] = {
    hubUrl: config.baseUrl,
    pushWorkflow: createGitWorkflowPusher(),
    log: (line) => log.info`${line}`,
    logError: (line) => log.error`${line}`,
    credentialCipher,
    pendingSeedStore: createDrizzlePendingSeedStore(db, credentialCipher),
    accessPolicy: {
      store: accessPolicyStore,
      envSignupMode: config.signupMode,
      envAllowedDomains: config.allowedEmailDomains,
      allowUnverifiedEmails: config.allowUnverifiedEmails,
    },
    // Same provider-health store `@workbench/connections`' own routes
    // report to and clear (CL-6092) — a successful `/complete` here must
    // clear the same record the shell banner's zero-provider "Fix it"
    // routed someone to onboarding to fix.
    providerHealth: providerHealthStore,
  };
  if (config.operatorTenantId !== undefined)
    onboardingDeps.operatorTenantId = config.operatorTenantId;
  if (config.seedModel !== undefined)
    onboardingDeps.seedModel = config.seedModel;
  if (config.huggingfaceOAuthClientId !== undefined)
    onboardingDeps.huggingfaceClientId = config.huggingfaceOAuthClientId;
  if (config.githubAppClientId !== undefined)
    onboardingDeps.githubAppClientId = config.githubAppClientId;
  if (config.githubAppClientSecret !== undefined)
    onboardingDeps.githubAppClientSecret = config.githubAppClientSecret;

  app.route("/api/onboarding", createOnboardingRoutes(onboardingDeps));

  // Artifacts engine: mounts `@corbits/artifacts` against the same
  // Postgres cluster as this hub's control plane (its
  // `artifact`/`artifact_version` tables FK into `public.tenant` /
  // `public.principal`). Uses DATABASE_URL — the same URL as everything
  // else — so local `bun run dev` mounts Library with no extra env var.
  // When it's unset (or mount fails), degrades to 503 routes. When
  // mounted, tenant-scoped list + get + upload routes serve Library
  // under `/artifacts`.
  //
  // The mount runs migrations against the configured DB; if the URL is
  // present but points at an unreachable/invalid cluster the migration
  // would otherwise throw and take the whole hub down at boot. We catch
  // that here so the hub comes up in a degraded (no-artifacts) mode and
  // surfaces the failure as a warning rather than a crash.
  let artifactsHandle: Awaited<ReturnType<typeof mountArtifacts>>;
  try {
    artifactsHandle = await mountArtifacts();
  } catch (error) {
    log.warn(
      `Artifacts mount failed — continuing without artifacts persistence: ${error}`,
    );
    artifactsHandle = undefined;
  }
  if (artifactsHandle !== undefined) {
    app.route(
      `${TENANT_PREFIX}/artifacts`,
      createArtifactRoutes({
        store: createArtifactDbStore(
          artifactsHandle.db,
          artifactsHandle.contentStore,
        ),
        requireGrant: createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      }),
    );

    // The bench library's template shelf (CL-6344): what the
    // new-workbench picker instantiates from — seeded rows, never a
    // hardcoded import.
    app.route(
      `${TENANT_PREFIX}/library/templates`,
      createTemplateLibraryRoutes({
        store: createTemplateLibraryDbStore(artifactsHandle.db),
        requireGrant: createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      }),
    );

    // Co-editing persistence (CL-5958 phase 2): debounced snapshots of a
    // presence room's Y.Text into a real artifact version, layered on top
    // of the presence registry mounted above without changing its own
    // "ephemeral, no storage" default. `writeArtifactVersion`/`getArtifact`
    // are the engine's own versioned-row seam — the same one a workflow's
    // artifact revision goes through — so a co-edited text artifact's
    // history reads identically to any other revision. `anonymousIdentity`
    // is not used here: `writeArtifactVersion` only needs a `{tenantId,
    // principalId}` scope, not a resolved `Identity`.
    const artifactDb = artifactsHandle.db;
    const artifactPersistence = createArtifactDocPersistence({
      registry: presenceRoomRegistry,
      loadArtifactContent: async (tenantId, artifactId) => {
        const row = await getArtifact(artifactDb, artifactId);
        if (row === null || row.tenantId !== tenantId) return null;
        return row.content;
      },
      writeArtifactSnapshot: async (
        tenantId,
        artifactId,
        authorPrincipalId,
        content,
      ) => {
        const written = await writeArtifactVersion(artifactDb, {
          scope: { tenantId, principalId: authorPrincipalId },
          artifactId,
          content,
        });
        return { version: written.version };
      },
      onSnapshotError: (key, error) => {
        log.warn(
          `Co-editing snapshot failed for ${key.tenantId}/${key.surface}: ${error}`,
        );
      },
    });
    artifactSeedOnJoin = artifactPersistence.seedOnJoin;
  } else {
    log.info("Artifacts handle unavailable (degraded mode)");
    app.route(
      `${TENANT_PREFIX}/artifacts`,
      createUnavailableArtifactRoutes(
        createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      ),
    );
  }

  // The sanctioned path for a workflow run to persist and read Library
  // artifacts (CL-6000): mounted OUTSIDE `TENANT_PREFIX` since a
  // workflow-process child has no browser session — every request here
  // authenticates via `createWorkflowRunAuthenticator` (the sidecar's own
  // bearer token plus the run's own address) against this hub's own
  // control-plane `db`, never the artifacts engine's db.
  if (artifactsHandle !== undefined) {
    app.route(
      "/api/workflow-artifacts",
      createWorkflowArtifactRoutes({
        authenticator: createWorkflowRunAuthenticator({ db }),
        store: createWorkflowArtifactDbStore(artifactsHandle.db),
      }),
    );
  } else {
    app.route(
      "/api/workflow-artifacts",
      createUnavailableWorkflowArtifactRoutes(),
    );
  }

  // Tells the signed-out screen which OAuth buttons to draw, without
  // exposing the credentials themselves — just which providers a full
  // pair was configured for. No session or tenant is required to ask,
  // since this decides what the sign-in screen even offers.
  const enabledSocialProviders = Object.keys(config.socialProviders);
  app.get("/api/auth-config", (c) =>
    c.json({
      socialProviders: enabledSocialProviders,
      signupMode: config.signupMode,
      allowedEmailDomains: config.allowedEmailDomains,
    }),
  );

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));

  // [Intx gap] CL-6041: the native POST /api/tenants route is ungated —
  // wrap the fully-built app in a guard that enforces
  // @workbench/access-policy in front of it. See
  // ./tenant-create-guard.ts's module comment for why this has to be an
  // outer wrap rather than an `app.use()` added here: the native route
  // is already registered by the time `createApp()` returns above, and
  // Hono composes handlers in registration order.
  const guardDeps: Parameters<typeof guardedHubApp>[1] = {
    store: accessPolicyStore,
    resolveCallerRoleNames: (tenantId, userId) =>
      resolveCallerRoleNames(db, tenantId, userId),
    envSignupMode: config.signupMode,
    envAllowedDomains: config.allowedEmailDomains,
    allowUnverifiedEmails: config.allowUnverifiedEmails,
    getSessionUser: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result
        ? {
            id: result.user.id,
            email: result.user.email,
            emailVerified: result.user.emailVerified,
          }
        : undefined;
    },
  };
  if (config.operatorTenantId !== undefined) {
    guardDeps.operatorTenantId = config.operatorTenantId;
  }
  const guardedApp = guardedHubApp(app, guardDeps);

  // Env-key auto-plant (CL-6101): runs in-process against the app this
  // function is about to return, so it needs nothing more than that
  // app's own `fetch` — see ./env-credential-plant.ts. A no-op when no
  // curated provider key is set in this process's environment.
  const envCredentialPlant = scheduleEnvProviderCredentialPlant({
    baseUrl: config.baseUrl,
    envProviderKeys: config.envProviderKeys,
    envProviderBaseUrls: config.envProviderBaseUrls,
    admin: config.envCredentialPlantAdmin,
    fetch: (request) => Promise.resolve(guardedApp.fetch(request)),
  });

  // Bench-library template seed (CL-6344): the hub, as system, plants
  // the shipped workbench template manifests and their tool tarballs
  // into the operator bench's library at boot — idempotently, so a
  // second boot leaves exactly one entry per template. Skipped in
  // degraded (no-artifacts) mode: with no library to seed into there is
  // nothing honest to do. See ./template-library-seed.ts.
  const templateLibrarySeed =
    artifactsHandle !== undefined
      ? scheduleTemplateLibrarySeed({
          baseUrl: config.baseUrl,
          admin: config.envCredentialPlantAdmin,
          fetch: (request) => Promise.resolve(guardedApp.fetch(request)),
          artifactsDb: artifactsHandle.db,
          entries: WORKBENCH_TEMPLATES.map((template) => ({
            id: template.id,
            content: serializeWorkbenchTemplateManifest(template),
          })),
        })
      : { stop: (): void => {} };

  return {
    app: guardedApp,
    db,
    close: async () => {
      sidecarAllocationReconciliationStopped = true;
      if (sidecarAllocationReconciliationTimer !== undefined) {
        clearTimeout(sidecarAllocationReconciliationTimer);
      }
      envCredentialPlant.stop();
      templateLibrarySeed.stop();
      chatOrchestrator.dispose();
      taskOrchestrator.dispose();
      taskLifecycle.stop();
      stuckLegSweep.stop();
      routineScheduler.stop();
      credentialExpirySweep.stop();
      await insightsUsage.close();
      await insightsLatency.close();
      await preferences.close();
      await benchSettings.close();
      await closeMailbox();
      await close();
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
  const shutdown = async () => {
    await server.stop();
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
