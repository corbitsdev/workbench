// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createDB, createGrantStore } from "@intx/db";
import { generateKeyPair } from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import { createApp, createRequireGrant, type AppEnv } from "@intx/hub-api";
import {
  createChatRoutes,
  createDrizzleChatStore,
  createHubChatPlatform,
} from "@corbits/chat";
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
import { createEchoRoutes } from "@workbench/echo";
import { createGitWorkflowPusher } from "@workbench/hub-client";
import { createOnboardingRoutes } from "@workbench/onboarding";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, type Next } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { readHubConfig, type HubConfig } from "./config";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const REGISTRIES = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const CHAT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
// Falls back to the same anthropic/claude-sonnet-5 pairing the workbench
// seed plants when no seed model credential is configured for this hub,
// so a channel host can always resolve an inference source.
const DEFAULT_CHANNEL_HOST_INFERENCE_PREFERENCES = [
  { provider: "anthropic", model: "claude-sonnet-5" },
];

// Open signup is safe by enumeration: BYOK means there is nothing free
// to burn, and the hosted deployment only ever runs Corbits-signed
// packages, so signup mints no operator-credential grants. Only
// email+password signup is wired up — it is the only path anything in
// apps/web actually drives end to end. OTP verification and social
// sign-in return once a transactional-email credential and real UI
// exist for them; wiring either in ahead of that would be dead surface
// that also risks logging a verification secret with nowhere honest to
// send it.
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
  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: createDrizzleChatStore(db),
    platform: createHubChatPlatform({
      db,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    }),
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    channelHostInferencePreferences:
      config.seedModel !== undefined
        ? [
            {
              provider: config.seedModel.provider,
              model: config.seedModel.model,
            },
          ]
        : DEFAULT_CHANNEL_HOST_INFERENCE_PREFERENCES,
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));

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

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));
  return { app, db, close };
}

if (import.meta.main) {
  await setup();
  const config = readHubConfig(process.env);
  mkdirSync(config.hubDataDir, { recursive: true });
  const hub = await createHub(config);
  const url = new URL(config.baseUrl);
  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
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
