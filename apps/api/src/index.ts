import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { schema as intxSchema } from '@intx/db';
import { createApp } from '@intx/hub-api';
import { getLogger, setup } from '@intx/log';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadConfig } from './config';
import { createWorkflowRouter } from './routes/workflow';
import * as workbenchSchema from './db/schema';

await setup({ dev: process.env.NODE_ENV !== 'production' });
const log = getLogger(['api']);

const config = loadConfig();

// ─── Database ──────────────────────────────────────────────────────

import { resolveDatabaseConfig } from './lib/db';

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

const { isDev, cors: corsConfig, auth: authConfig, google } = config;
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

// ─── Stubbed sidecar dependencies ─────────────────────────────────

const sidecarRouter = {
  getConnectedSidecars: () => [],
  dispatchAgentEvent: () => {},
  handleOpen: () => {},
  handleMessage: () => {},
  handleClose: () => {},
  events: { on: () => {} },
} as any;

const sessionService = {} as any;

const eventCollectors = {} as any;

// ─── Hub app ────────────────────────────────────────────────────────

const hub = createApp({
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
    headers.set('Access-Control-Allow-Origin', corsOrigins[0]);
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
});

// ─── Parent Hono with intercepts ────────────────────────────────────

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

// Intercept sidecar-dependent routes
app.use('/api/sidecars/*', async (c) => c.json({ error: 'not implemented' }, 501));
app.use('/api/tenants/:tenantId/agents/instances/*', async (c) =>
  c.json({ error: 'not implemented' }, 501)
);
app.use('/api/tenants/:tenantId/credentials/*', async (c) =>
  c.json({ error: 'not implemented' }, 501)
);

// Mount hub app
app.route('/', hub);

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

// ─── Web SPA (when built into the container) ────────────────────────

app.use('/*', serveStatic({ root: './apps/web/dist' }));
app.get('/*', serveStatic({ path: './apps/web/dist/index.html' }));

// ─── Health ─────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    db: 'connected',
    auth: 'ready',
    timestamp: new Date().toISOString(),
  });
});

const port = Number(config.port);

if (import.meta.main) {
  log.info('API starting', { port });
}

export { app };
export default {
  port,
  fetch: app.fetch,
};
