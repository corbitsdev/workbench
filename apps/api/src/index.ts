import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { createDB } from '@intx/db';
import { createApp } from '@intx/hub-api';
import { getLogger } from '@intx/log';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins/magic-link';
import { createWorkflowRouter } from './routes/workflow';

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

const dbConfig = {
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? '5433'),
  user: process.env['DB_USER'] ?? 'workbench',
  password: process.env['DB_PASSWORD'] ?? 'workbench-dev-password',
  database: process.env['DB_NAME'] ?? 'workbench',
};

const { db } = createDB(dbConfig);
log.info('Database connection established');

// ─── Auth ──────────────────────────────────────────────────────────

const corsOrigin = process.env['CORS_ORIGIN'];
const isCrossOrigin = Boolean(corsOrigin);

const auth = betterAuth({
  baseURL: process.env['BETTER_AUTH_BASE_URL'] ?? 'http://localhost:4000',
  secret: requireEnv('BETTER_AUTH_SECRET'),
  trustedOrigins: corsOrigin ? [corsOrigin] : undefined,
  database: drizzleAdapter(db, { provider: 'pg' }),
  advanced: isCrossOrigin
    ? { defaultCookieAttributes: { sameSite: 'none', secure: true } }
    : undefined,
  plugins: [
    magicLink({
      disableSignUp: false,
      sendMagicLink: async ({ email, url }) => {
        log.info('Magic link (dev mode — no email provider configured)', { email, url });
      },
    }),
  ],
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

const v1 = new Hono();

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
