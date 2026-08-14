// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createApprovalStore, createDB, createGrantStore } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { and, eq } from "drizzle-orm";
import { generateKeyPair } from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import {
  createApp,
  createRequireGrant,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";

import { createAgentDefinitionRoutes } from "@corbits/agent-directory";

import {
  createChannelHostInferencePreferencesResolver,
  createChannelTenancyRoutes,
  createChatOrchestrator,
  createChatRoutes,
  createDrizzleBlockResponseStore,
  createDrizzleChannelTenancyStore,
  createDrizzleChatStore,
  createDrizzleThreadStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  listConnectedProviders,
  startWorkflowCommand,
} from "@corbits/chat";
import { createCryptoProviderCache } from "@corbits/folded-runs";
import {
  createInboxRoutes,
  createWorkbenchMailboxDelivery,
  WORKBENCH_MAILBOX_VOCABULARY,
} from "@corbits/inbox";
import {
  applyInsightsMigrations,
  createInsightsRoutes,
  createPostgresUsageStore,
  createUsageSink,
} from "@corbits/insights";
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
  createDrizzleDraftStore,
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
import {
  createArtifactDbStore,
  createArtifactRoutes,
  createUnavailableArtifactRoutes,
} from "@corbits/artifacts-hub";
import { createEchoRoutes } from "@workbench/echo";
import { createGitWorkflowPusher } from "@workbench/hub-client";
import { createOnboardingRoutes } from "@workbench/onboarding";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
} from "@corbits/notify";
import { mountMemory } from "./memory-mount";
import { mountArtifacts } from "./artifacts-mount";
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
  const threadStore = createDrizzleThreadStore(db);
  const blockResponseStore = createDrizzleBlockResponseStore(db);
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
    threads: threadStore,
    blockResponses: blockResponseStore,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
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
  // runTraceReader is intentionally unmounted until a real reader exists.
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
  const routineDraftStore = createDrizzleDraftStore(db);
  const routineLauncher = createHubRoutineLauncher({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
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

  // Memory plane (optional): firm-memory HTTP under
  // `/api/tenants/:tenantId/memory/*`. Degrades when
  // KNOWLEDGE_DATABASE_URL / EMBED_* are unset — see memory-mount.ts.
  mountMemory({
    app,
    grantStore: chatGrantStore,
    conditionRegistry: chatConditionRegistry,
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
  if (config.huggingfaceOAuthClientId !== undefined)
    onboardingDeps.huggingfaceClientId = config.huggingfaceOAuthClientId;

  app.route("/api/onboarding", createOnboardingRoutes(onboardingDeps));

  // Artifacts engine: mounts `@corbits/artifacts` against the same
  // Postgres cluster as this hub's control plane (its
  // `artifact`/`artifact_version` tables FK into `public.tenant` /
  // `public.principal`). Resolves URL as ARTIFACTS_DATABASE_URL →
  // DATABASE_URL so local `bun run dev` mounts Library without a second
  // env var. When neither is set (or mount fails), degrades to 503
  // routes. When mounted, tenant-scoped list + get + upload routes serve
  // Library under `/artifacts`.
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
  return {
    app,
    db,
    close: async () => {
      chatOrchestrator.dispose();
      routineScheduler.stop();
      credentialExpirySweep.stop();
      await insightsUsage.close();
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
