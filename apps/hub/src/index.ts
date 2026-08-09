// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createDB, createGrantStore } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { and, eq } from "drizzle-orm";
import { generateKeyPair } from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import { createApp, createRequireGrant, type AppEnv } from "@intx/hub-api";
import {
  createChatOrchestrator,
  createChatRoutes,
  createDrizzleChannelTenancyStore,
  createDrizzleChatStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  startWorkflowCommand,
} from "@corbits/chat";
import { createCryptoProviderCache } from "@corbits/folded-runs";
import { createAgentDefinitionRoutes } from "@corbits/agent-directory";
import {
  createDrizzleWebhookTriggerStore,
  createWebhookIngressRoutes,
  createWebhookTriggerRoutes,
  launchWebhookTrigger,
} from "@corbits/webhook-triggers";
import {
  createCommandRegistry,
  createCommandRoutes,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import {
  createDrizzleRoutineStore,
  createRoutineRoutes,
} from "@corbits/routines";
import {
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarRouter,
  createSidecarTokenAuthenticator,
  type WsHandle,
} from "@intx/hub-sessions";
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import { createNeedsYouRoutes } from "@corbits/approvals";
import { createEchoRoutes } from "@workbench/echo";
import { createGitWorkflowPusher } from "@workbench/hub-client";
import { createOnboardingRoutes } from "@workbench/onboarding";
import { mountArtifacts } from "./artifacts-mount";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, type Next } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { readHubConfig, type HubConfig } from "./config";
import { createHubRoutineLauncher } from "./routine-launcher";
import { createHubRunSummaryResolver } from "./routine-run-summary";
import { createRoutineScheduler } from "./routine-scheduler";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const REGISTRIES = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const CHAT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
// Shorter than CHAT_TURN_TIMEOUT_MS is fine: the lifecycle's own busy
// guard (wired off the event collector's current-turn id) spares a
// mid-turn instance regardless of this value, so it only has to be
// long enough that an agent between turns is never mistaken for idle.
const CHAT_IDLE_SLEEP_MS = 60_000;
// The same anthropic/claude-sonnet-5 pairing the workbench seed plants
// in the tenant catalog, so a channel host can always resolve an
// inference source against it.
const DEFAULT_CHANNEL_HOST_INFERENCE_PREFERENCES = [
  { provider: "anthropic", model: "claude-sonnet-5" },
];

// Open signup is safe by enumeration: BYOK means there is nothing free
// to burn, and the hosted deployment only ever runs Corbits-signed
// packages, so signup mints no operator-credential grants.
// Email+password signup is always wired up. Google/GitHub OAuth are
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

export async function createHub(config: HubConfig) {
  const { db, close } = createDB(dbConfigFromUrl(config.databaseUrl));
  const log = getLogger(["hub", "auth"]);
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
  const eventCollectors = createEventCollectorRegistry({ db });
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
    },
  });
  const app = createApp({
    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: (c) => auth.handler(c.req.raw),
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
  const chatStore = createDrizzleChatStore(db);
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
  // an invited agent's `connector.reply` events into channel messages
  // by subscribing to the sidecar's own event stream, replacing the
  // old per-agent reply-bridge machinery armed (and re-armed) from
  // inside the routes. `chatPlatform.recordActivity` is the same
  // idle-sleep lifecycle `chatPlatform` itself drives — wiring it here
  // too is what keeps a replying agent's activity clock current even
  // though the reply never goes through `chatPlatform.sendMail`'s own
  // `recordActivity` call.
  const chatOrchestrator = createChatOrchestrator({
    db,
    store: chatStore,
    platform: chatPlatform,
    events: sidecarRouter.events,
    recordActivity: chatPlatform.recordActivity,
  });
  // The "/name args" and "@name args" command registry: every tenant's
  // invitable workflow definitions, exposed as commands by
  // `createWorkflowCommandPlugin`, resolved fresh on every list/lookup
  // so a newly-deployed definition is a command on its very next use —
  // no re-registration step. `startWorkflow` is `@corbits/chat`'s own
  // `startWorkflowCommand`, sharing the exact invite-then-send core
  // `POST .../invite` uses.
  //
  // `publish` here is a no-op: the live per-channel SSE publish
  // function is built inside `createChatRoutes` itself (see
  // `channel-events.ts`'s subscriber registry), not exposed to this
  // composition root. A workflow started via a command still shows up
  // once the channel's settings are next fetched or its timeline is
  // next polled; it only misses the immediate live push a `POST
  // .../invite` triggers. Flagged for review — closing this gap means
  // either exposing that publish hook out of `createChatRoutes` or
  // moving command dispatch inside it.
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
            publish: () => undefined,
          },
          input,
        ),
    }),
  );

  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: chatStore,
    platform: chatPlatform,
    tenancy: chatTenancy,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    // Always the constant default: the hub's own seed model credential
    // (config.seedModel) never names a different provider or model, so
    // there is nothing for it to override here — only the onboarding
    // path below cares whether a real credential is configured.
    channelHostInferencePreferences: DEFAULT_CHANNEL_HOST_INFERENCE_PREFERENCES,
    commands: commandRegistry,
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));
  // Agent definitions a person authors by hand from the Agents page's
  // create form, materialized the same way the platform's own starter
  // agents are (see `@corbits/agent-directory`'s doc comment). Shares
  // `chatGrantStore`/`chatConditionRegistry` with every other extension
  // mounted here — there is nothing chat-specific about that pair, it
  // is just this composition root's one db-backed grant store.
  app.route(
    `${TENANT_PREFIX}/agent-definitions`,
    createAgentDefinitionRoutes({
      db,
      assetService,
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
  const webhookTriggerStore = createDrizzleWebhookTriggerStore(db);
  const webhookCryptoProviders = createCryptoProviderCache();
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
            cryptoProviderCache: webhookCryptoProviders,
          },
          trigger,
          payload,
        ),
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
  const routineLauncher = createHubRoutineLauncher({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
  });
  app.route(
    `${TENANT_PREFIX}/routines`,
    createRoutineRoutes({
      store: routineStore,
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

  // The first-login hook mounts outside the tenant prefix, since the
  // session it serves belongs to no tenant yet. The route is
  // `@workbench/onboarding`'s; what it decides is documented in that
  // package's provision.ts.
  const onboardingDeps: Parameters<typeof createOnboardingRoutes>[0] = {
    hubUrl: config.baseUrl,
    pushWorkflow: createGitWorkflowPusher(),
    log: (line) => log.info`${line}`,
  };
  if (config.operatorTenantId !== undefined)
    onboardingDeps.operatorTenantId = config.operatorTenantId;
  if (config.seedModel !== undefined)
    onboardingDeps.seedModel = config.seedModel;

  app.route("/api/onboarding", createOnboardingRoutes(onboardingDeps));

  // Artifacts engine: mounts `@corbits/artifacts` against the same
  // Postgres cluster as this hub's control plane (its
  // `artifact`/`artifact_version` tables FK into `public.tenant` /
  // `public.principal`). Degrades to a no-op when
  // `ARTIFACTS_DATABASE_URL` is unset. The handle is available for
  // tenant-scoped list/search/read routes; Library still uses the
  // asset-shim surface until those land.
  await mountArtifacts();

  // Tells the signed-out screen which OAuth buttons to draw, without
  // exposing the credentials themselves — just which providers a full
  // pair was configured for. No session or tenant is required to ask,
  // since this decides what the sign-in screen even offers.
  const enabledSocialProviders = Object.keys(config.socialProviders);
  app.get("/api/auth-config", (c) =>
    c.json({ socialProviders: enabledSocialProviders }),
  );

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));
  return {
    app,
    db,
    close: async () => {
      chatOrchestrator.dispose();
      routineScheduler.stop();
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
