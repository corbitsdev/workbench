import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { schema as intxSchema } from '@intx/db';
import { createApp } from '@intx/hub-api';
import { getLogger, setup } from '@intx/log';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createWorkflowRouter } from './routes/workflow';
import * as workbenchSchema from './db/schema';

await setup({ dev: process.env.NODE_ENV !== 'production' });
const log = getLogger(['api']);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ─── LLM Configuration ──────────────────────────────────────────────

requireEnv('OPENAI_COMPATIBLE_API_KEY');
const _llmModel = process.env['OPENAI_COMPATIBLE_MODEL'] || 'gpt-4o-mini';

log.info('LLM configured', { model: _llmModel });

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

const corsOrigin = process.env['CORS_ORIGIN'];
const isCrossOrigin = Boolean(corsOrigin);
const isDev = process.env['NODE_ENV'] !== 'production';

const allowedDomains = process.env['GOOGLE_ALLOWED_DOMAINS']
  ? process.env['GOOGLE_ALLOWED_DOMAINS'].split(',').map((d) => d.trim()).filter(Boolean)
  : [];

const auth = betterAuth({
  baseURL: process.env['BETTER_AUTH_BASE_URL'] ?? 'http://localhost:4000',
  secret: requireEnv('BETTER_AUTH_SECRET'),
  trustedOrigins: isDev
    ? Array.from({ length: 10 }, (_, i) => `http://localhost:${5173 + i}`)
    : corsOrigin
      ? [corsOrigin]
      : undefined,
  database: drizzleAdapter(db, { provider: 'pg' }),
  advanced:
    isCrossOrigin && !isDev
      ? { defaultCookieAttributes: { sameSite: 'none', secure: true } }
      : undefined,
  socialProviders: {
    google: {
      clientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (allowedDomains.length === 0) return;
          const domain = user.email.split('@')[1];
          if (!domain || !allowedDomains.includes(domain)) {
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
    if (corsOrigin) {
      const headers = new Headers();
      for (const [key, value] of response.headers) {
        headers.append(key, value);
      }
      headers.set('Access-Control-Allow-Origin', corsOrigin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
  db,
  sidecarRouter,
  sessionService,
  eventCollectors,
});

// ─── Parent Hono with intercepts ────────────────────────────────────

const app = new Hono();

app.use('*', honoLogger());

if (corsOrigin) {
  app.use(
    cors({
      origin: corsOrigin,
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

// ─── Workbench routes ──────────────────────────────────────────────

const v1 = new Hono<{ Variables: { userId: string } }>();

v1.use('*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) return c.json({ error: 'Unauthorized' }, 401);
  c.set('userId', result.user.id);
  await next();
});

v1.route('/', createWorkflowRouter(db));

app.route('/api/v1', v1);

// ─── Health ─────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    db: 'connected',
    auth: 'ready',
    timestamp: new Date().toISOString(),
  });
});

const port = Number(process.env['PORT'] ?? 4000);

if (import.meta.main) {
  log.info('API starting', { port });
}

export { app };
export default {
  port,
  fetch: app.fetch,
};
