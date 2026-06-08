import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { schema as intxSchema, createGrantStore, resolveInstanceSources } from '@intx/db';
import { createApp } from '@intx/hub-api';
import {
  createAgentRepoStore,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarRouter,
  type WsHandle,
} from '@intx/hub-sessions';
import { hexEncode } from '@intx/types';
import { getLogger, setup } from '@intx/log';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { resolveDatabaseConfig } from './lib/db';
import { createWorkflowRouter } from './routes/workflow';
import { createAgentProvisioningRouter, relaunchInstanceIfNeeded } from './routes/agents';
import { createWorkbenchesRouter } from './routes/workbenches';
import { createApprovalsRouter, createInternalApprovalsRouter } from './routes/approvals';
import { createInternalToolsRouter } from './routes/tools';
import { buildToolDefinitions } from './lib/tool-registry';
import { schema } from './db';
import { loadSigningKeyRegistry } from './lib/signing-keys';
import {
  provisionMyraInstance,
  seedGlobalTenant,
  ensureGlobalMember,
} from './lib/tenant-provisioning';
import {
  migrateCredentialsToPlaintext,
  verifyPlaintextMigration,
} from './lib/migrate-credentials-to-plaintext';
import { initSentry } from '@workbench/sentry';

await initSentry();
await setup({ dev: process.env.NODE_ENV !== 'production' });
const log = getLogger(['api']);

const config = loadConfig();

// ─── Database ──────────────────────────────────────────────────────

const dbConfig = resolveDatabaseConfig();

const sql = postgres({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  max: 10,
  ...(dbConfig.ssl !== undefined && { ssl: dbConfig.ssl }),
});
const db = drizzle(sql, { schema });

await sql`SELECT 1`;
log.info('Database connection established');

// One-time migration: decrypt any enc:v1:* credentials written by the old
// app-layer encryption path. Safe to re-run — already-plaintext rows are skipped.
const migrationResult = await migrateCredentialsToPlaintext(db, config.credentialKeys);
const remaining = await verifyPlaintextMigration(db);
if (remaining > 0) {
  log.error('Credential plaintext migration incomplete — aborting startup', {
    remaining,
    ...migrationResult,
  });
  process.exit(1);
}

// ─── Global org tenant bootstrap ───────────────────────────────────
//
// Seed the single shared org tenant (name/slug/domain from env). Idempotent and
// race-safe across replicas — creates it on first boot, returns the existing id
// thereafter. Fail-loud: if the org tenant cannot be seeded the hub must not
// start, because every same-domain user joins it as a principal.
const { tenantId: globalTenantId } = await seedGlobalTenant(db);
log.info('Global org tenant ready', { globalTenantId });

const { isDev, cors: corsConfig, auth: authConfig, google, hub } = config;

// ─── Auth ──────────────────────────────────────────────────────────
const { origins: corsOrigins, isCrossOrigin } = corsConfig;

log.info('CORS config loaded', { corsOrigins, corsCount: corsOrigins.length });

const auth = betterAuth({
  baseURL: authConfig.baseUrl,
  secret: authConfig.secret,
  trustedOrigins: isDev
    ? Array.from({ length: 10 }, (_, i) => `http://localhost:${5173 + i}`)
    : corsOrigins,
  database: drizzleAdapter(db, { provider: 'pg' }),
  account: {
    skipStateCookieCheck: true,
  },
  advanced: isCrossOrigin
    ? { defaultCookieAttributes: { sameSite: 'none', secure: true } }
    : undefined,
  socialProviders:
    google.clientId && google.clientSecret
      ? {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
          },
        }
      : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (google.allowedDomains.length === 0) return;
          const domain = user.email.split('@')[1];
          if (!domain || !google.allowedDomains.includes(domain)) {
            throw new Error(`Email domain not allowed`);
          }
        },
        after: async (user) => {
          try {
            // Join the shared global org tenant as a member principal and
            // provision this user's own Myra inside it (per-user definition +
            // instance, keyed on the member principal). This is the sole
            // provisioning path — personal tenants are gone (CL-1452).
            const { principalId: globalPrincipalId } = await ensureGlobalMember(db, {
              userId: user.id,
            });
            const { paInstanceId: globalMyraInstanceId } = await provisionMyraInstance(db, {
              tenantId: globalTenantId,
              tenantDomain: config.globalTenant.domain,
              userId: user.id,
              creatorPrincipalId: globalPrincipalId,
            });

            log.info('User provisioned', {
              userId: user.id,
              globalTenantId,
              globalPrincipalId,
              globalMyraInstanceId,
            });
          } catch (err) {
            log.error(
              'Global-tenant provisioning failed for new user — repair runs on next login',
              {
                userId: user.id,
                error: err instanceof Error ? err : new Error(String(err)),
              }
            );
          }
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          // Repair path: if global-tenant provisioning failed at signup, retry
          // silently on login. Both calls are idempotent and key on the user's
          // global member principal, so a healthy user is a no-op. No personal
          // (user-) tenant logic remains (CL-1452).
          try {
            const { principalId } = await ensureGlobalMember(db, { userId: session.userId });
            await provisionMyraInstance(db, {
              tenantId: globalTenantId,
              tenantDomain: config.globalTenant.domain,
              userId: session.userId,
              creatorPrincipalId: principalId,
            });
          } catch (err) {
            log.error('Session repair failed — continuing', {
              userId: session.userId,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        },
      },
    },
  },
});

// ─── Signing key registry ──────────────────────────────────────────

const registry = loadSigningKeyRegistry(hub.signingKeys);
log.info('Loaded signing key registry: active version {version}', {
  version: registry.active.version,
});

// ─── Agent repo store ──────────────────────────────────────────────

const agentRepoStore = createAgentRepoStore({
  dataDir: hub.dataDir,
  signingKey: registry.active,
});

// ─── Hub services ──────────────────────────────────────────────────

const grantStore = createGrantStore(db);

const lookups = createHubSessionLookups({ db, agentRepoStore });

const sidecarRouter = createSidecarRouter({
  hubPublicKey: hexEncode(registry.active.publicKey),
  lookups,
});

const eventCollectors = createEventCollectorRegistry({
  db,
  onTurnFinalized(agentAddress, turn) {
    sidecarRouter.dispatchAgentEvent(agentAddress, {
      type: 'turn.committed',
      data: {
        turnId: turn.turnId,
        status: turn.status,
        text: turn.text,
        hadReply: turn.hadReply,
        hadError: turn.hadError,
        errors: turn.errors,
        toolCalls: turn.toolCalls,
        toolErrors: turn.toolErrors,
      },
    });
  },
});

createHubSessionOrchestrator({
  events: sidecarRouter.events,
  router: sidecarRouter,
  db,
  eventCollectors,
  grantStore,
  agentRepoStore,
});

const sessionService = createSessionService({
  sidecarRouter,
  agentRepoStore,
});

// ─── Hub app ────────────────────────────────────────────────────────
//
// createApp() registers auth routes internally. app.use(cors()) added
// after createApp() won't intercept OPTIONS because Hono matches the
// all() route first. The parent `app` wrapping ensures cors() runs
// before any route dispatch.

const hubApp = createApp({
  getSession: async (headers) => {
    const result = await auth.api.getSession({ headers });
    return result ? { user: result.user, session: result.session } : null;
  },
  authHandler: async (c) => {
    const response = await auth.handler(c.req.raw);
    if (!isCrossOrigin) return response;
    const headers = new Headers();
    for (const [key, value] of response.headers) {
      headers.append(key, value);
    }
    const requestOrigin = c.req.header('Origin') ?? '';
    const allowedOrigin = corsOrigins.includes(requestOrigin) ? requestOrigin : corsOrigins[0];
    if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  db,
  sidecarRouter,
  sessionService,
  eventCollectors,
  grantStore,
  assetService: null,
  repoStore: null,
  sidecarWsHandler: upgradeWebSocket((_c) => {
    let handle: WsHandle;
    return {
      onOpen(_evt, ws) {
        handle = {
          send(data: string) {
            ws.send(data);
          },
          close() {
            ws.close();
          },
        };
        sidecarRouter.handleOpen(handle);
      },
      onMessage(evt, _ws) {
        if (typeof evt.data === 'string') {
          sidecarRouter.handleMessage(handle, evt.data);
        }
      },
      onClose(_evt, _ws) {
        sidecarRouter.handleClose(handle);
      },
    };
  }),
});

// ─── Parent Hono ────────────────────────────────────────────────────

const app = new Hono();

app.use('*', honoLogger());

if (corsOrigins.length > 0) {
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    })
  );
}

// Mount hub app
app.route('/', hubApp);

// ─── Workbench routes ──────────────────────────────────────────────

const v1 = new Hono<{ Variables: { userId: string; userName: string } }>();

v1.use('*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', result.user.id);
  c.set('userName', result.user.name ?? result.user.email ?? 'Unknown');
  await next();
});

v1.get('/me', async (c) => {
  const userId = c.get('userId');

  // The user's working tenant is the shared global org tenant (CL-1452). Repair
  // path: if signup/session provisioning failed, ensure the member principal and
  // their Myra here — both idempotent, so a healthy user is a no-op.
  let workingTenantId: string | null = null;
  let memberPrincipalId: string | null = null;
  try {
    const { tenantId, principalId } = await ensureGlobalMember(db, { userId });
    workingTenantId = tenantId;
    memberPrincipalId = principalId;
  } catch (err) {
    log.error('Failed to ensure global member on /me', {
      userId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  let paInstanceId: string | null = null;
  if (workingTenantId && memberPrincipalId) {
    const { paInstanceId: instanceId } = await provisionMyraInstance(db, {
      tenantId: workingTenantId,
      tenantDomain: config.globalTenant.domain,
      userId,
      creatorPrincipalId: memberPrincipalId,
    });
    paInstanceId = instanceId;

    // If credentials are already granted but no session is running, relaunch automatically.
    try {
      await relaunchInstanceIfNeeded(
        db,
        sessionService,
        grantStore,
        eventCollectors,
        instanceId,
        sidecarRouter.events
      );
    } catch (err) {
      log.warn('Auto-relaunch of Myra session failed — user will need to re-add credentials', {
        userId,
        instanceId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const userName = c.get('userName');

  let credentialResolved = false;
  if (paInstanceId && workingTenantId) {
    const paInstance = await db.query.agentInstance.findFirst({
      where: eq(intxSchema.agentInstance.id, paInstanceId),
    });
    if (paInstance) {
      try {
        const sources = await resolveInstanceSources(db, workingTenantId, {
          agentId: paInstance.agentId,
          sessionId: null,
        });
        credentialResolved = sources.length > 0;
      } catch {
        credentialResolved = false;
      }
    }
  }

  return c.json({
    userId,
    userName,
    // Legacy field name retained for the web client; this is the user's working
    // (global org) tenant id now, not a personal tenant. Rename is a follow-up.
    personalTenantId: workingTenantId,
    paInstanceId,
    provisioned: workingTenantId !== null,
    credentialResolved,
  });
});

v1.route('/', createWorkflowRouter(db));
v1.route(
  '/',
  createAgentProvisioningRouter(db, sessionService, grantStore, sidecarRouter, eventCollectors)
);
v1.route('/', createWorkbenchesRouter(db));
v1.route('/', createApprovalsRouter(db));

app.route('/api/v1', v1);

// ─── Internal routes (sidecar token auth) ──────────────────────────

app.route('/api/internal', createInternalApprovalsRouter(db, config.sidecarToken));
app.route(
  '/api/internal',
  createInternalToolsRouter(db, config.sidecarToken, config.credentialKeys, {
    sessionService,
    eventCollectors,
    sidecarRouter,
    credentialKeys: config.credentialKeys,
    buildToolDefinitions,
  })
);

// The web SPA is deployed as its own static Railway service (apps/web),
// not served from here. The hub is API-only.

// ─── Health ─────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({});
});

const port = Number(config.port);

if (import.meta.main) {
  log.info('API starting', { port });
}

// ─── Graceful shutdown ──────────────────────────────────────────────
//
// Stop accepting new connections and wait up to 10 s for in-flight
// requests to drain before exiting. Railway sends SIGTERM then waits
// 10 s before SIGKILL — this uses that window rather than dying instantly.

let server: ReturnType<typeof Bun.serve> | undefined;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    log.info('Received {signal}, draining', { signal });
    await server?.stop();
    log.info('Server stopped, exiting');
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { error: err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal('Unhandled rejection', { error: err });
});

export { app };

server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
