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
import { and, eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createWorkflowRouter } from './routes/workflow';
import { workflowRegistry } from '@workbench/workflow-core';
import {
  createAgentProvisioningRouter,
  relaunchInstanceIfNeeded,
  persistInstanceToolGrants,
} from './routes/agents';
import { createWorkbenchesRouter } from './routes/workbenches';
import { createApprovalsRouter, createInternalApprovalsRouter } from './routes/approvals';
import { createInternalToolsRouter } from './routes/tools';
import { buildToolDefinitions, getToolNamesFromCapabilities } from './lib/tool-registry';
import { schema } from './db';
import { loadSigningKeyRegistry } from './lib/signing-keys';
import {
  seedGlobalTenant,
  seedAgentTemplates,
  seedTenantWorkflows,
  ensureGlobalMember,
  provisionMemberInstances,
  getMyraInstanceId,
} from './lib/tenant-provisioning';
import { initSentry } from '@workbench/sentry';

await initSentry();
await setup({ dev: process.env.NODE_ENV !== 'production' });
const log = getLogger(['api']);

const config = loadConfig();

// ─── Database ──────────────────────────────────────────────────────

const sql = postgres(config.databaseUrl);
const db = drizzle(sql, { schema });

await sql`SELECT 1`;
log.info('Database connection established');

// ─── Global org tenant bootstrap ───────────────────────────────────
//
// Seed the single shared org tenant (name/slug/domain from env). Idempotent and
// race-safe across replicas — creates it on first boot, returns the existing id
// thereafter. Fail-loud: if the org tenant cannot be seeded the hub must not
// start, because every same-domain user joins it as a principal.
const { tenantId: globalTenantId } = await seedGlobalTenant(db);
log.info('Global org tenant ready', { globalTenantId });

// Seed each agent template as a first-class agent definition in the global org
// tenant so admins can manage them and members get per-user instances later
// (CL-1530). Depends on the global tenant existing. Fail-loud.
await seedAgentTemplates(db);
log.info('Agent templates seeded');

// Seed tenant-scoped workflow rows so every registered workflow is available to
// all members of the global org tenant without any per-user action. Idempotent.
await seedTenantWorkflows(
  db,
  globalTenantId,
  workflowRegistry.list().map((w) => w.kind)
);
log.info('Tenant workflows seeded', { tenantId: globalTenantId });

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
  emailAndPassword: { enabled: true },
  advanced:
    !isDev && isCrossOrigin
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
          // Domain restriction only applies to OAuth (Google) sign-ups.
          // Email/password is allowed for local dev.
          if (google.allowedDomains.length === 0) return;
          const domain = user.email.split('@')[1];
          if (!domain || !google.allowedDomains.includes(domain)) {
            throw new Error(`Email domain not allowed`);
          }
        },
        after: async (user) => {
          try {
            const { principalId: globalPrincipalId } = await ensureGlobalMember(db, {
              userId: user.id,
            });
            log.info('User joined global tenant', {
              userId: user.id,
              globalTenantId,
              globalPrincipalId,
            });
          } catch (err) {
            log.error('Global-tenant membership failed for new user', {
              userId: user.id,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          // Repair path: ensure global-tenant membership on login in case signup hook failed.
          try {
            await ensureGlobalMember(db, { userId: session.userId });
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

const rawSessionService = createSessionService({
  sidecarRouter,
  agentRepoStore,
});

// Wrap launchSession so that Interchange's native instance-creation path
// (which always passes tools: []) picks up tool definitions from the agent's
// capabilities column. Our own provisioning route already passes the correct
// tools; the guard on tools.length === 0 avoids double-injection there.
const sessionService: typeof rawSessionService = {
  ...rawSessionService,
  async launchSession(params) {
    if (params.config.tools.length === 0) {
      const agentRow = await db.query.agent.findFirst({
        where: eq(intxSchema.agent.id, params.agentId),
      });
      if (agentRow?.capabilities) {
        const toolNames = getToolNamesFromCapabilities(agentRow.capabilities);
        if (toolNames.length > 0) {
          const tools = buildToolDefinitions(toolNames);
          await persistInstanceToolGrants(db, {
            tenantId: params.config.tenantId,
            principalId: params.config.principalId,
            toolNames,
            now: new Date(),
          });
          // Re-collect grants after persisting tool grants — the snapshot
          // in params.config.grants was built before persistence and is stale.
          const grants = await grantStore.collectGrants(
            params.config.principalId,
            params.config.tenantId
          );
          params = { ...params, config: { ...params.config, tools, grants } };
          log.info('Injected tool definitions for agent {agentId}', {
            agentId: params.agentId,
            toolNames,
          });
        }
      }
    }
    return rawSessionService.launchSession(params);
  },
};

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
    const { memberAgentInstance } = schema;
    const mapping = await db.query.memberAgentInstance.findFirst({
      where: and(
        eq(memberAgentInstance.tenantId, workingTenantId),
        eq(memberAgentInstance.memberPrincipalId, memberPrincipalId),
        eq(memberAgentInstance.templateKey, 'myra')
      ),
    });
    paInstanceId = mapping?.instanceId ?? null;

    // If the mapping is missing (e.g. user deleted Myra), re-provision it.
    if (!paInstanceId) {
      try {
        const instances = await provisionMemberInstances(db, {
          userId,
          memberPrincipalId: memberPrincipalId,
        });
        paInstanceId = getMyraInstanceId(instances);
      } catch (err) {
        log.warn('Failed to re-provision Myra on /me', {
          userId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // If credentials are already granted but no session is running, relaunch automatically.
    if (paInstanceId) {
      try {
        await relaunchInstanceIfNeeded(
          db,
          sessionService,
          grantStore,
          eventCollectors,
          paInstanceId,
          sidecarRouter
        );
      } catch (err) {
        log.warn('Auto-relaunch of Myra session failed — user will need to re-add credentials', {
          userId,
          instanceId: paInstanceId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
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

v1.route('/', createWorkflowRouter(db, grantStore));
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
  createInternalToolsRouter(db, config.sidecarToken, {
    sessionService,
    eventCollectors,
    sidecarRouter,
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
