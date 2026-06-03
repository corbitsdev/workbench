import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { schema as intxSchema, createGrantStore } from '@intx/db';
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
import { loadConfig } from './config';
import { resolveDatabaseConfig } from './lib/db';
import { createWorkflowRouter } from './routes/workflow';
import * as workbenchSchema from './db/schema';
import { loadSigningKeyRegistry } from './lib/signing-keys';

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
const db = drizzle(sql, { schema: { ...intxSchema, ...workbenchSchema } });

log.info('Database connection established');

// ─── Auth ──────────────────────────────────────────────────────────

const { isDev, cors: corsConfig, auth: authConfig, google, hub } = config;
const { origins: corsOrigins, isCrossOrigin } = corsConfig;

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
    if (corsOrigins[0]) headers.set('Access-Control-Allow-Origin', corsOrigins[0]);
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

// ─── Dev login (for local development without Google OAuth) ──────────

if (isDev && !google.clientId) {
  app.get('/api/auth/dev-session', async (c) => {
    return c.json({
      user: {
        id: 'dev-user',
        email: 'dev@example.com',
        name: 'Dev User',
        emailVerified: true,
      },
      session: {
        id: 'dev-session',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        token: 'dev-token',
        createdAt: new Date(),
      },
    });
  });
}

// ─── Workbench routes ──────────────────────────────────────────────

const v1 = new Hono<{ Variables: { userId: string } }>();

v1.use('*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    if (isDev && !google.clientId) {
      c.set('userId', 'dev-user');
      log.debug('Dev mode: using fake user');
      return next();
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', result.user.id);
  await next();
});

v1.route('/', createWorkflowRouter(db));

app.route('/api/v1', v1);

// The web SPA is deployed as its own static Railway service (apps/web),
// not served from here. The hub is API-only.

// ─── Health ─────────────────────────────────────────────────────────

const startTime = Date.now();

app.get('/health', (c) => {
  return c.json({
    status: 'connected',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
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
