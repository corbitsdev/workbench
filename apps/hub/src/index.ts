// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createApprovalStore, createDB, createGrantStore } from "@intx/db";
import {
  model,
  tenant as tenantTable,
  workflowDefinition,
} from "@intx/db/schema";
import { and, eq } from "drizzle-orm";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
  generateKeyPair,
} from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import type { CredentialCipher } from "@intx/types";
import {
  createApp,
  createRequireGrant,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";

import {
  AGENT_SKILLS_ASSET_PATH,
  buildAgentDefinitionWorkflow,
  createAgentDefinitionRoutes,
  reindexPinnedSkills,
  serializeAgentDefinitionWorkflow,
  serializeAgentSkills,
} from "@corbits/agent-directory";

import {
  createArtifactDeliveryHandler,
  createChannelHostInferencePreferencesResolver,
  createChannelSubscriberRegistry,
  createChannelTenancyRoutes,
  createChatOrchestrator,
  createChatRoutes,
  createDrizzleBlockResponseStore,
  createDrizzleChannelTenancyStore,
  createDrizzleChatStore,
  createDrizzlePinStore,
  createDrizzleReactionStore,
  createDrizzleThreadStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  listConnectedProviders,
  startWorkflowCommand,
} from "@corbits/chat";
import type { FinalizedTurnToolCall } from "@corbits/turn-artifacts";
import { createCryptoProviderCache } from "@corbits/folded-runs";
import {
  createInboxRoutes,
  createWorkbenchMailboxDelivery,
  WORKBENCH_MAILBOX_VOCABULARY,
} from "@corbits/inbox";
import {
  applyInsightsMigrations,
  createDrizzleRunTraceReader,
  createInsightsRoutes,
  createPostgresUsageStore,
  createUsageSink,
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
  launchWebhookTrigger,
} from "@corbits/webhook-triggers";
import {
  isAutomatableWorkflowName,
  workflowDisplayName,
} from "@corbits/workflow-catalog";
import {
  createDrizzleDraftStore,
  createDrizzleRoutineStore,
  createRoutineRoutes,
} from "@corbits/routines";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  createDrizzleTaskStore,
  createTaskOrchestrator,
  createTaskRoutes,
  launchTask,
} from "@corbits/tasks";
import {
  createPlannerRoutes,
  dispatchWithPlanner,
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
  createSidecarRouter,
  createSidecarTokenAuthenticator,
  DEFAULT_ASSET_REF,
  ensureWorkflowDefinitionForAsset,
  type WsHandle,
} from "@intx/hub-sessions";
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import { createNeedsYouRoutes } from "@corbits/approvals";
import { getArtifact, writeArtifactVersion } from "@corbits/artifacts";
import {
  createArtifactDbStore,
  createArtifactRoutes,
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
import { createConnectionRoutes } from "@workbench/connections";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
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
import { readHubConfig, type HubConfig } from "./config";
import { createLocalRoutineDrafting } from "./local-routine-drafting";
import { createHubRoutineLauncher } from "./routine-launcher";
import { createHubRunSummaryResolver } from "./routine-run-summary";
import { createRoutineScheduler } from "./routine-scheduler";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const REGISTRIES = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
// In-repo tool packages (`packages/granola-tools`, `packages/linear-tools`,
// `packages/artifact-tools`) are unpublished to npm and stay that way:
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
// `CORBITS_TOOLS_REGISTRY` with the package's tarball; until then,
// resolution fails loud rather than silently falling through to npmjs
// (which could never carry an unpublished scope anyway).
const CORBITS_TOOLS_REGISTRY = "corbits-tools";
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const CHAT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
// Shorter than CHAT_TURN_TIMEOUT_MS is fine: the lifecycle's own busy
// guard (wired off the event collector's current-turn id) spares a
// mid-turn instance regardless of this value, so it only has to be
// long enough that an agent between turns is never mistaken for idle.
const CHAT_IDLE_SLEEP_MS = 60_000;

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
  const lookups = createHubSessionLookups({ db, agentRepoStore });
  const sidecarRouter = createSidecarRouter({
    hubPublicKey: hexEncode(signingKey.publicKey),
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
  const artifactDeliveryHandlerRef: {
    current?: (
      agentAddress: string,
      turn: { toolCalls: FinalizedTurnToolCall[] },
    ) => void;
  } = {};
  const eventCollectors = createEventCollectorRegistry({
    db,
    onTurnFinalized: (agentAddress, turn) =>
      artifactDeliveryHandlerRef.current?.(agentAddress, turn),
  });
  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
    agentRepoStore,
  });
  const sessionService = createSessionService({
    sidecarRouter,
    agentRepoStore,
    assetService,
    db,
    toolPackageRegistries: {
      httpRegistries: REGISTRIES,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@corbits", registry: CORBITS_TOOLS_REGISTRY }],
    },
  });
  const app = createApp({
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
  // here in the composition root — the same pattern `channelSubscribers`
  // above uses. Presence rooms are ephemeral and process-local by design
  // (see `@corbits/presence`'s docs/presence.md); the registry is built
  // here rather than inside `createPresenceRoutes` itself so the
  // co-editing doc-persistence wiring below (which needs the artifacts
  // engine, mounted further down once its own DB handle resolves) can
  // share the exact same registry the routes below serve traffic
  // through — the same way `startWorkflowCommand` shares
  // `channelSubscribers`.
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
  // Mounted outside the tenant prefix — the sidecar reaches it as a
  // plain inference endpoint, never through tenant-scoped auth, the
  // same way it reaches a real provider's API. `config.baseUrl` (not
  // `localhost`) is what makes the URL usable: the sidecar that
  // deploys a channel host's instance is a separate process (often a
  // separate machine) from this hub, so only the hub's own public
  // origin resolves for it.
  app.route("/api/chat/noop-inference", createNoopInferenceRoutes());
  const chatTenancy = createDrizzleChannelTenancyStore(db, {
    conditionRegistry: chatConditionRegistry,
  });
  // Mounted outside the tenant prefix, like `/api/onboarding`: the bench
  // switcher asks this across every tenant a signed-in user belongs to,
  // not one tenant at a time (see `apps/web/src/bench-context.tsx`).
  app.route(
    "/api/channel-tenancies",
    createChannelTenancyRoutes({ tenancy: chatTenancy }),
  );
  const chatPlatform = createHubChatPlatform({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    noopInferenceBaseUrl: `${config.baseUrl}/api/chat/noop-inference`,
    lifecycle: { idleSleepMs: CHAT_IDLE_SLEEP_MS },
  });
  // Built once, beside the platform, for the process's lifetime: turns
  // an invited agent's `connector.reply` events into channel messages,
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
  const chatOrchestrator = createChatOrchestrator({
    db,
    store: chatStore,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    recordActivity: chatPlatform.recordActivity,
    ...(memoryHandle !== undefined ? { memory: memoryHandle.memory } : {}),
  });
  // Now that `chatStore`/`chatPlatform` exist, arm the finalized-turn
  // artifact-delivery ref declared beside `eventCollectors` above.
  // `memory` (absent when the plane isn't mounted) lets this handler
  // also record a memory entry for each persisted artifact (CL-5852).
  artifactDeliveryHandlerRef.current = createArtifactDeliveryHandler({
    db,
    store: chatStore,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    ...(memoryHandle !== undefined ? { memory: memoryHandle.memory } : {}),
  });
  // The one SSE subscriber registry for this process's channel events
  // (see `@corbits/chat`'s `channel-events.ts`), constructed here in
  // the composition root and shared by both consumers below: the
  // chat router bridges it onto `/channels/:id/stream`, and the
  // workflow-command path publishes through the same instance so a
  // command-started workflow's join event reaches an open stream
  // immediately, exactly like `POST .../invite`'s does.
  const channelSubscribers = createChannelSubscriberRegistry();
  // The "/name args" and "@name args" command registry: every tenant's
  // invitable workflow definitions, exposed as commands by
  // `createWorkflowCommandPlugin`, resolved fresh on every list/lookup
  // so a newly-deployed definition is a command on its very next use —
  // no re-registration step. `startWorkflow` is `@corbits/chat`'s own
  // `startWorkflowCommand`, sharing the exact invite-then-send core
  // `POST .../invite` uses, including its live `publish` — bound to
  // `channelSubscribers` above, the same registry `createChatRoutes`
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
            publish: channelSubscribers.publish,
          },
          input,
        ),
    }),
  );

  // The one "is this a conversational agent?" ruling, shared by every
  // picker that offers agents to a person — chat's invite/new-chat
  // pickers and the task composer alike: automatable catalog workflows
  // (routines material) belong in neither.
  const isConversationalAgentDefinition = (definition: { name: string }) =>
    !isAutomatableWorkflowName(definition.name);

  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: chatStore,
    platform: chatPlatform,
    tenancy: chatTenancy,
    threads: threadStore,
    blockResponses: blockResponseStore,
    reactions: reactionStore,
    pins: pinStore,
    channelSubscribers,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    isInvitableDefinition: isConversationalAgentDefinition,
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    // Derived per tenant, per channel creation, from that tenant's own
    // connected catalog providers (see `@corbits/chat`'s
    // `createChannelHostInferencePreferencesResolver`) — never a fixed
    // provider/model pair, so a bench whose only credential is, say,
    // OpenRouter still gets a channel host that can resolve a source.
    channelHostInferencePreferences:
      createChannelHostInferencePreferencesResolver((tenantId) =>
        listConnectedProviders(db, tenantId),
      ),
    commands: commandRegistry,
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));
  // Slack tag ingress (CL-5288 Phase 1): mounted OUTSIDE the tenant
  // prefix and outside session auth, like the webhook ingress below —
  // Slack is not a principal, and this route resolves its own
  // Interchange identity per message (see `./slack-tag-mount.ts` and
  // `@corbits/slack-tag`'s signature-verification-gated dispatch). A
  // missing SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET pair is a valid
  // configuration — the mount is silently skipped.
  await mountWorkbenchSlackTag({
    app,
    db,
    databaseUrl: config.databaseUrl,
    chatStore,
    chatPlatform,
    chatTenancy,
    channelSubscribers,
    channelHostInferencePreferences: chatDeps.channelHostInferencePreferences,
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
  });
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
  await applyInsightsMigrations(config.databaseUrl);
  const insightsUsage = createPostgresUsageStore(config.databaseUrl);
  // Sink constructed so the store path is live for reads, but left
  // unsubscribed: Interchange's event-collector drops inference.usage and
  // exposes no product-side usage stream that carries tenantId + turnId
  // with the tokens. sidecarRouter.events ("agent.event") does surface
  // raw inference.usage, but correlating turn/tenant requires collector-
  // private state or a DB scrape — not a clean <30-line subscribe.
  // Pending an Interchange usage event stream, do not invent fake turns.
  void createUsageSink({
    store: insightsUsage.store,
    generateId: () => generateId("inferenceTurn"),
  });
  app.route(
    `${TENANT_PREFIX}/insights`,
    createInsightsRoutes({
      store: insightsUsage.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      runTraceReader: createDrizzleRunTraceReader(db),
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
  app.route(
    `${TENANT_PREFIX}/agent-definitions`,
    createAgentDefinitionRoutes({
      db,
      assetService,
      skillIndex: skills.skillIndex,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
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
      channelBelongsToTenant: async (tenantId, channelId) =>
        (await chatStore.getChannelSettings(tenantId, channelId)) !==
          undefined ||
        (await chatStore.hasLaunchedInstance(tenantId, channelId)),
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
            cryptoProviderCache: foldedRunCryptoProviders,
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
      // Same env bag `onboardingDeps.huggingfaceClientId` below feeds
      // the OAuth connect flow itself, so `GET .../oauth-configured`
      // reports exactly what a Connect click would decide.
      oauthEnv: { huggingfaceClientId: config.huggingfaceOAuthClientId },
    }),
  );
  // Routines: its own grant store (routines authorize against the
  // `workflow-run:*` resource family, the same one native run routes
  // use — see `@corbits/routines`' routes.ts), the launcher adapter
  // that turns a routine's `launchRoutineRun` call into a real folded
  // run via `@corbits/folded-runs` (routine-launcher.ts), and a run
  // summary resolver so `GET /routines/:id/runs` reports each fire's
  // real status instead of a bare run id.
  const routineGrantStore = createGrantStore(db);
  const routineStore = createDrizzleRoutineStore(db);
  const routineDraftStore = createDrizzleDraftStore(db);
  const routineLauncher = createHubRoutineLauncher({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    cryptoProviderCache: foldedRunCryptoProviders,
  });
  // Routines routes own their `/routines` and `/routine-drafts` prefixes, so
  // mount at the tenant root (same pattern as a package that ships absolute
  // resource paths) rather than under a second `/routines` segment.
  app.route(
    TENANT_PREFIX,
    createRoutineRoutes({
      store: routineStore,
      drafts: routineDraftStore,
      // Local prompt→steps drafting until Myra owns the port. Auto-pin a
      // definitionId only when the tenant has exactly one workflow definition
      // so describe-to-agent drafts are approvable without a second pick.
      // 0 or >1 → null (honest; approve path still needs an explicit pick).
      drafting: createLocalRoutineDrafting({
        resolveDefinitionId: async (tenantId) => {
          const rows = await db.query.workflowDefinition.findMany({
            where: eq(workflowDefinition.tenantId, tenantId),
            columns: { id: true },
            limit: 2,
          });
          return rows.length === 1 ? (rows[0]?.id ?? null) : null;
        },
      }),
      launcher: routineLauncher,
      requireGrant: createRequireGrant({
        grantStore: routineGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
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
  });

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
    store: createDrizzleCredentialExpirySweepStore(db),
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
  // channel, and its finalized reply lands in the Inbox through the
  // same notify delivery adapter `credentialExpirySweep` uses above.
  // Own idle-sleep lifecycle instance (same `@corbits/agent-lifecycle`
  // package chat's platform adapter drives, a separate instance since
  // chat's own lifecycle isn't part of `HubChatPlatform`'s public
  // surface) — `wake` is never actually called: a task's run only ever
  // needs waking to deliver a follow-up message, and a one-shot task
  // never sends one after its opening prompt.
  const taskStore = createDrizzleTaskStore(db);
  const taskLifecycle = createAgentLifecycle({
    idleSleepMs: CHAT_IDLE_SLEEP_MS,
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

  // Myra auto-dispatch (CL-6051): a typed outcome becomes a validated
  // task plan via `@corbits/task-planner`, dispatched exactly like a
  // manually-launched task. Every inventory lister below generalizes a
  // pattern that already lives elsewhere in this composition root
  // (`isConversationalAgentDefinition`, `chatDeps.channelHostInferencePreferences`'s
  // per-tenant connected-provider derivation) — this package owns the
  // inventory's shape, never the listing logic.
  const memoryToolPackageName = "@corbits/memory-tools";

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
      .filter((row) => isConversationalAgentDefinition(row))
      .map((row) => ({
        id: row.id,
        name: row.name,
        displayName: workflowDisplayName(row.name, row.description),
        ...(row.description !== null ? { description: row.description } : {}),
      }));
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
        entries.push({ name: toolPackageName, connectorId: descriptor.id });
      }
    }
    if (memoryHandle !== undefined) {
      entries.push({ name: memoryToolPackageName, connectorId: "memory" });
    }
    return entries;
  }

  async function listMyraModels(
    tenantId: string,
  ): Promise<readonly InventoryModel[]> {
    const rows = await db.query.model.findMany({
      where: and(eq(model.tenantId, tenantId), eq(model.disabled, false)),
    });
    return rows.map((row) => ({
      canonicalName: row.canonicalName,
      ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    }));
  }

  const plannerInventorySources: InventorySources = {
    listConversationalAgents: listMyraConversationalAgents,
    listUsableToolPackages: listMyraUsableToolPackages,
    listSkills: (caller) => skills.registry.list(caller),
    memoryAvailable: memoryHandle !== undefined,
    listModels: listMyraModels,
  };

  // Mirrors `@corbits/agent-directory`'s own private
  // `AGENT_DEFINITION_ASSET_PATH` constant (not exported — the route
  // module keeps it internal), kept in lockstep by convention since
  // this is the same asset-tree contract `ensureWorkflowDefinitionForAsset`
  // reads back from.
  const PLANNER_AGENT_DEFINITION_ASSET_PATH = "workflow.json";

  function slugifyAgentHandle(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // A random suffix rather than the create-route's duplicate-asset
    // retry/409 dance: a planner-created handle is never shown to a
    // person to retype, so collision recovery has no UI to serve — a
    // random suffix makes collision practically impossible instead.
    const suffix = generateId("workflowDefinition").slice(-8);
    return `${base === "" ? "agent" : base}-${suffix}`;
  }

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
    readonly systemPrompt: string;
    readonly toolPackagePins: readonly string[];
    readonly skills: readonly string[];
    readonly model?: string;
  }): Promise<{ readonly definitionId: string }> {
    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenantTable.id, input.tenantId),
    });
    if (tenantRow === undefined) {
      throw new Error(`No tenant "${input.tenantId}"`);
    }

    const handle = slugifyAgentHandle(input.name);
    const skillEntries =
      input.skills.length > 0
        ? await skills.skillIndex.resolve(
            input.tenantId,
            input.principalId,
            input.skills,
          )
        : [];

    const definition = buildAgentDefinitionWorkflow({
      handle,
      tenantDomain: tenantRow.domain,
      description: "",
      systemPrompt: input.systemPrompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.toolPackagePins.length > 0
        ? {
            toolPackagePins: input.toolPackagePins.map((name) => ({
              name,
              version: "*",
            })),
          }
        : {}),
    });
    const workflowJson = reindexPinnedSkills(
      serializeAgentDefinitionWorkflow(definition),
      skillEntries,
    );
    const skillsJson = serializeAgentSkills(input.skills);

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
        files: {
          [PLANNER_AGENT_DEFINITION_ASSET_PATH]: workflowJson,
          [AGENT_SKILLS_ASSET_PATH]: skillsJson,
        },
        message: `Define agent ${input.name}`,
      },
    });

    const { definitionId } = await ensureWorkflowDefinitionForAsset(
      db,
      created.id,
    );
    return { definitionId };
  }

  // A separate `CryptoProviderCache` from the task launcher's own
  // (`taskLauncherDeps.cryptoProviders`): a planning run's instance id
  // is never a real task's, but the cache is keyed by instance id
  // regardless, and a planning run's one-shot prompt/reply cadence has
  // nothing to do with a launched task's — separate caches keep the
  // two lifecycles from ever contending over the same key space.
  const plannerCryptoProviders = createCryptoProviderCache();

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
          },
          input,
        ),
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
    credentialCipher,
    pendingSeedStore: createDrizzlePendingSeedStore(db, credentialCipher),
    accessPolicy: {
      store: accessPolicyStore,
      envSignupMode: config.signupMode,
      envAllowedDomains: config.allowedEmailDomains,
      allowUnverifiedEmails: config.allowUnverifiedEmails,
    },
  };
  if (config.operatorTenantId !== undefined)
    onboardingDeps.operatorTenantId = config.operatorTenantId;
  if (config.seedModel !== undefined)
    onboardingDeps.seedModel = config.seedModel;
  if (config.huggingfaceOAuthClientId !== undefined)
    onboardingDeps.huggingfaceClientId = config.huggingfaceOAuthClientId;

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
  const guardedApp = guardedHubApp(app, {
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
    ...(config.operatorTenantId !== undefined
      ? { operatorTenantId: config.operatorTenantId }
      : {}),
  });

  return {
    app: guardedApp,
    db,
    close: async () => {
      chatOrchestrator.dispose();
      taskOrchestrator.dispose();
      taskLifecycle.stop();
      routineScheduler.stop();
      credentialExpirySweep.stop();
      await insightsUsage.close();
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
