import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { describeRoute, openAPIRouteHandler } from 'hono-openapi';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { schema as intxSchema, createGrantStore } from '@intx/db';
import { createApp, createRequireGrant } from '@intx/hub-api';
import { timeWindowEvaluator } from '@intx/authz';
import {
  createAgentRepoStore,
  createAssetService,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarRouter,
  WORKSPACE_BUILTINS_REGISTRY,
  type SidecarLookups,
  type WsHandle,
} from '@intx/hub-sessions';
// Per-agent serialized event-collector registry (CL-1656). Drop-in for
// @intx/hub-sessions' createEventCollectorRegistry; serializes onEvent per
// agent so a turn row commits before its parts, fixing the FK race that
// dropped thinking/reply parts.
import { createEventCollectorRegistry } from '@workbench/event-collector';
import { createAnalyticsSubscriber, createAnalyticsRoutes } from '@workbench/analytics';
import { parseInferenceEvent } from '@intx/types/runtime';
import { type } from 'arktype';
import { hexEncode } from '@intx/types';
import { createNodeCrypto } from '@intx/crypto-node';
import { getLogger } from '@intx/log';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig } from './config';
import { createSidecarConnectionRegistry } from './sidecar-connections';
import {
  createWorkflowDeployGrantGuard,
  createWorkflowDeployRouter,
  deployWorkflowHandler,
  deleteWorkflowHandler,
  type WorkflowDeployCoreDeps,
} from './routes/workflow-deploy';
import { createWorkflowRunsRouter, type EnsureDeploymentRoutableFn } from './routes/workflow-runs';
import { createWorkflowRunRecordsRouter } from './routes/workflow-run-records';
import {
  abortRunHandler,
  abortActiveRunsHandler,
  abortRunRouteDescription,
  abortActiveRunsRouteDescription,
} from './routes/workflow-run-abort';
import { wrapRepoStoreWithProjection } from './workflow-executor/projection-bridge';
import { createWorkflowDeployService } from './services/workflow-deploy';
import { createInternalWorkflowSkillsRouter } from './routes/workflow-skills';
import { createWorkflowReconciler } from './services/workflow-reconciler';
import { createWorkbenchDirectorRegistry } from '@workbench/agents';
import { createUploadsRouter } from './routes/uploads';
import { createSkillsRouter } from './routes/skills';
import { createAgentProvisioningRouter } from './routes/agents';
import {
  relaunchInstanceIfNeeded,
  registerDisconnectReconciler,
  resolveInstanceSourcesFromDefinition,
} from './services/agent-provisioning';
import { createMembersRouter } from './routes/members';
import { createArtifactsRouter } from './routes/artifacts';
import { createGammaTemplatesRouter } from './routes/gamma-templates';
import { createApprovalsRouter, createInternalApprovalsRouter } from './routes/approvals';
import { createFeedbackRouter } from './routes/feedback';
import { createHubToolsRouter } from './routes/hub-tools';
import { createToolCredentialsRouter } from './routes/tool-credentials';
import { createToolManifestRouter } from './routes/tool-manifest';
import { createInternalDeploymentsRouter } from './routes/internal-deployments';
import { buildToolDefinitions } from './lib/tool-registry';
import { schema } from './db';
import { loadSigningKeyRegistry } from './lib/signing-keys';
import {
  seedGlobalTenant,
  seedAgentTemplates,
  ensureGlobalMember,
  provisionMemberInstances,
  getMyraInstanceId,
} from './lib/tenant-provisioning';
import { setupObservability, flushSentry } from '@workbench/sentry';
import { serverErrorReporter, SERVER_ERROR_LOGGED } from './lib/server-error-logger';
import { createFatalErrorRecovery } from './lib/fatal-error-recovery';
import { resolveCorsAllowOrigin } from './lib/cors-origin';
import { createRateLimiter } from './lib/rate-limit';

await setupObservability({ dev: process.env.NODE_ENV !== 'production' });
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

// Re-seed agent templates (Myra, Oat, …) into the global tenant on every boot
// so a deploy that changes a template's prompt, tool-package pins, or
// capabilities actually reaches the agent rows. seedGlobalTenant returns early
// when the tenant already exists, so without this the rows stay frozen at
// whatever an earlier manual seed wrote (CL-1530's "seeded at hub boot"
// contract was never wired). Idempotent upsert; fail-loud to surface a
// malformed template at deploy rather than silently shipping stale agents.
await seedAgentTemplates(db);
log.info('Agent templates seeded', { globalTenantId });

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
  emailAndPassword: {
    enabled: true,
    // Hash with Bun.password (argon2id) instead of better-auth's default scrypt
    // so the owner-run create-user script can produce a matching hash directly
    // in the DB without going through the sign-up HTTP route (see
    // apps/hub/bin/create-user.ts).
    password: {
      hash: (password) => Bun.password.hash(password),
      verify: ({ hash, password }) => Bun.password.verify(password, hash),
    },
  },
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

const repoStore = wrapRepoStoreWithProjection(
  createAgentRepoStore({
    dataDir: hub.dataDir,
    signingKey: registry.active,
  }),
  { db }
);
// ─── Skill asset substrate ─────────────────────────────────────────

const assetService = createAssetService({ db, repoStore: repoStore.repoStore });

// ─── Hub services ──────────────────────────────────────────────────

const grantStore = createGrantStore(db);

const baseLookups = createHubSessionLookups({ db, agentRepoStore: repoStore });

function isWorkflowRunBootstrapRace(message: string): boolean {
  return /non_fast_forward: ref refs\/heads\/main expected null but found [0-9a-f]{40}/.test(
    message
  );
}

const lookups: SidecarLookups = {
  ...baseLookups,
  async receiveWorkflowRunPack(repoId, pack, ref, commitSha) {
    if (repoId.kind !== 'workflow-run') {
      throw new Error(
        `hub-session lookups receiveWorkflowRunPack received unsupported repo kind ${JSON.stringify(repoId.kind)}`
      );
    }
    const deploymentId = repoId.id;
    try {
      await repoStore.receiveWorkflowRunPack(
        { kind: 'workflow-run', id: deploymentId },
        pack,
        ref,
        commitSha
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('path_violation')) {
        log.warn('Workflow-run pack rejected for {deploymentId}: {message}', {
          deploymentId,
          message: msg,
        });
        return { accepted: false, reason: 'path_violation' as const };
      }
      if (isWorkflowRunBootstrapRace(msg)) {
        log.warn('Workflow-run pack bootstrap race for {deploymentId}: {message}', {
          deploymentId,
          message: msg,
        });
        return { accepted: false, reason: 'corrupt' as const };
      }
      log.error('Workflow-run pack receive failed for {deploymentId}: {message}', {
        deploymentId,
        message: msg,
      });
      return { accepted: false, reason: 'corrupt' as const };
    }
    return { accepted: true };
  },
};

const sidecarRouter = createSidecarRouter({
  hubPublicKey: hexEncode(registry.active.publicKey),
  lookups,
});

const analyticsSubscriber = createAnalyticsSubscriber({ db });

sidecarRouter.events.on('agent.event', ({ agentAddress, event }) => {
  const validated = parseInferenceEvent(event);
  if (validated instanceof type.errors) {
    log.warn('Skipping analytics for invalid agent event: {summary}', {
      summary: validated.summary,
    });
    return;
  }
  void analyticsSubscriber.onAgentEvent({ agentAddress, event: validated });
});

const sidecarConnections = createSidecarConnectionRegistry();

const fatalErrorRecovery = createFatalErrorRecovery(db);

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

    fatalErrorRecovery(agentAddress, turn);
  },
});

createHubSessionOrchestrator({
  events: sidecarRouter.events,
  router: sidecarRouter,
  db,
  eventCollectors,
  grantStore,
  agentRepoStore: repoStore,
});

// The orchestrator above only abandons event collectors on sidecar.disconnect;
// it leaves agent_session rows active so a transient reconnect can resume. When
// a sidecar fully restarts and the address never reconnects, the stale session
// would wedge the instance (relaunch sees an "active" session and bails). This
// reconciles those orphaned sessions after a grace window so /me can relaunch.
//
// ASSUMES A SINGLE HUB REPLICA. The reconcile decision reads this hub's
// in-memory getRoutableAddresses(); the disconnect event is also local to this
// hub's sidecar sockets. With multiple replicas a sidecar could reconnect to
// replica B while replica A — which still sees the address as unroutable —
// ends the session, reintroducing the CL-1651 relaunch churn/eviction. Before
// scaling the hub horizontally, gate this on a shared (DB-backed) routability
// signal instead of local router state.
registerDisconnectReconciler({ db, router: sidecarRouter });

const sessionService = createSessionService({
  sidecarRouter,
  agentRepoStore: repoStore,
  assetService,
  db,
  // Asset-sourced tool packages: the resolver auto-includes every
  // package-registry asset visible to the agent's tenant keyed by
  // asset.name, so the workspace-builtins asset satisfies the default
  // registry. No HTTP registries — our tarballs are self-contained.
  // Only consulted for agents with non-empty toolPackagePins.
  toolPackageRegistries: {
    httpRegistries: new Map(),
    defaultRegistry: WORKSPACE_BUILTINS_REGISTRY,
  },
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
    const allowedOrigin = resolveCorsAllowOrigin(c.req.header('Origin'), corsOrigins);
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
  assetService,
  repoStore: repoStore.repoStore,
  maxTarballBytes: 10 * 1024 * 1024,
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
        sidecarConnections.track(handle);
      },
      onMessage(evt, _ws) {
        if (typeof evt.data === 'string') {
          sidecarRouter.handleMessage(handle, evt.data);
        }
      },
      onClose(_evt, _ws) {
        sidecarConnections.untrack(handle);
        sidecarRouter.handleClose(handle);
      },
    };
  }),
});

const requireGrant = createRequireGrant({
  grantStore,
  conditionRegistry: { time_window: timeWindowEvaluator },
});

hubApp.route(
  '/api/tenants/:tenantId/analytics',
  createAnalyticsRoutes({ db, requireRead: requireGrant('analytics:*', 'read') })
);

// ─── Parent Hono ────────────────────────────────────────────────────

const app = new Hono<{ Variables: { [SERVER_ERROR_LOGGED]?: boolean } }>();

app.use('*', honoLogger());

// Report any >= 500 response — including handled errors returned via c.json
// that never throw — to the error log / Sentry sink.
app.use('*', serverErrorReporter());

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

// Brute-force defense on credential sign-in. Single-process in-memory limiter;
// infra-level limiting across replicas is still expected in production.
app.use('/api/auth/sign-in/*', createRateLimiter({ windowMs: 60_000, max: 10 }));

// ─── OpenAPI ─────────────────────────────────────────────────────────
//
// Shadows the Interchange-internal /openapi.json so the spec covers all
// workbench routes (ours + Interchange's), not just Interchange's. Order
// matters: app.route() flattens a sub-app's routes into the parent at call
// time, and Hono runs the first-registered handler for a path. Registering
// this before mounting hubApp ensures our handler shadows the sub-app's copy.
// openAPIRouteHandler walks app.routes lazily at request time, so it still
// captures every sub-app route mounted after this point. Auth routes are
// excluded via RegExp — hono-openapi only treats RegExp instances as patterns.
app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: { title: 'GTM Workbench', version: '1.0.0' },
      servers: [{ url: config.auth.baseUrl }],
    },
    exclude: ['/openapi.json', '/health', '/status', /^\/api\/auth\//],
  })
);

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
        log.warn('Auto-relaunch of Myra session failed', {
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
        const agentRow = await db.query.agent.findFirst({
          where: eq(intxSchema.agent.id, paInstance.agentId),
        });
        if (agentRow) {
          const resolution = await resolveInstanceSourcesFromDefinition(
            db,
            workingTenantId,
            agentRow,
            paInstance.modelPreferences
          );
          credentialResolved = resolution.ok && resolution.sources.length > 0;
        }
      } catch (err) {
        log.warn('Instance source resolution failed on /me', {
          error: err,
          tenantId: workingTenantId,
        });
        credentialResolved = false;
      }
    }
  }

  // Find all root tenants (parentId = null) the user belongs to. These are
  // Interchange-created personal tenants and the global org — none of them
  // should appear as selectable workbenches in the UI.
  const rootTenantIds: string[] = [];
  try {
    const rootPrincipals = await db
      .select({ tenantId: intxSchema.principal.tenantId })
      .from(intxSchema.principal)
      .innerJoin(intxSchema.tenant, eq(intxSchema.tenant.id, intxSchema.principal.tenantId))
      .where(
        and(
          eq(intxSchema.principal.refId, userId),
          eq(intxSchema.principal.kind, 'user'),
          isNull(intxSchema.tenant.parentId)
        )
      );
    for (const row of rootPrincipals) {
      rootTenantIds.push(row.tenantId);
    }
  } catch (err) {
    // non-fatal — frontend falls back to filtering only personalTenantId
    log.warn('Root tenant lookup failed on /me', { error: err, userId });
  }

  return c.json({
    userId,
    userName,
    // Legacy field name retained for the web client; this is the user's working
    // (global org) tenant id now, not a personal tenant. Rename is a follow-up.
    personalTenantId: workingTenantId,
    rootTenantIds,
    paInstanceId,
    provisioned: workingTenantId !== null,
    credentialResolved,
  });
});

v1.route(
  '/',
  createAgentProvisioningRouter(db, sessionService, grantStore, sidecarRouter, eventCollectors)
);
v1.route('/', createMembersRouter(db));
v1.route('/', createArtifactsRouter(db));
v1.route('/', createGammaTemplatesRouter(db));
v1.route('/', createApprovalsRouter(db));
v1.route('/', createFeedbackRouter(db));
v1.route('/', createUploadsRouter(db));
v1.route('/', createSkillsRouter(db, assetService, repoStore.repoStore));
// Built before the runs router so the run-start/signal handlers and the
// reconciler can share its idempotent `ensureDeploymentRoutable` re-establish
// primitive.
const workflowDeployService = createWorkflowDeployService({
  db,
  repoStore,
  sidecarRouter,
  sessionService,
  directorRegistry: createWorkbenchDirectorRegistry(),
});

const hubPublicKeyHex = hexEncode(registry.active.publicKey);

// Pre-bind the re-establish primitive over the deployment domain so callers
// pass only the per-deployment identity. Idempotent and coalesced per
// deploymentId inside the service.
const ensureDeploymentRoutable: EnsureDeploymentRoutableFn = (args) =>
  workflowDeployService.ensureDeploymentRoutable({
    ...args,
    deploymentDomain: config.globalTenant.domain,
  });

v1.route(
  '/',
  createWorkflowRunsRouter({
    db,
    repoStore: repoStore.repoStore,
    sidecarRouter,
    sessionService,
    cryptoProvider: createNodeCrypto(registry.active),
    deploymentDomain: config.globalTenant.domain,
    ensureDeploymentRoutable,
  })
);

// Workflow runs (CL-2243): /workflow-exec start/resume drive the SIDECAR
// supervisor (definition deployed like an agent) and persist run state to a
// workflow_run_record row the UI polls; the projection bridge wrapped around
// repoStore folds the sidecar's run events into that row.
v1.route(
  '/',
  createWorkflowRunRecordsRouter({
    db,
    sidecarRouter,
    sessionService,
    cryptoProvider: createNodeCrypto(registry.active),
    deploymentDomain: config.globalTenant.domain,
    ensureDeploymentRoutable,
  })
);

// Hub-as-control-plane reconciler (CL-2224): re-establish workflow supervisors
// from DB + workflow-repo state on startup and on every sidecar reconnect, so
// runs survive hub/sidecar restarts. Idempotent — a no-op when supervisors are
// already routable.
const workflowReconciler = createWorkflowReconciler({
  db,
  events: sidecarRouter.events,
  ensureDeploymentRoutable,
  getRoutableAddresses: sidecarRouter.getRoutableAddresses,
  deploymentDomain: config.globalTenant.domain,
});
workflowReconciler.start();
// CL-2248: fail orphaned in-flight runs FIRST, on the pre-reconcile routable
// snapshot — before reconcileAll re-registers supervisors and makes every run
// look routable. Then re-establish supervisors so NEW runs work.
void workflowReconciler
  .failOrphanedRuns()
  .catch((err) => {
    log.warn('initial failOrphanedRuns failed', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  })
  .then(() => workflowReconciler.reconcileAll())
  .catch((err) => {
    log.warn('initial workflow reconcile failed', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });

// Workflow deploy, shared by the session-authorized operator path
// (/api/v1/workflows/deploy, gated by the native grant check) and the
// service-token machine path (/api/internal/workflows/deploy).
const workflowDeployCoreDeps: WorkflowDeployCoreDeps = {
  db,
  workflowDeployService,
  sessionService,
  hubPublicKey: hubPublicKeyHex,
  deploymentDomain: config.globalTenant.domain,
  globalTenantId,
};

v1.post(
  '/workflows/deploy',
  createWorkflowDeployGrantGuard({ db, grantStore, globalTenantId }),
  deployWorkflowHandler(workflowDeployCoreDeps)
);

// DELETE/undeploy a workflow deployment. Same operator grant guard as the
// session-authorized deploy route; tenant-scoped lookup keeps a caller from
// deleting another tenant's deployment.
v1.delete(
  '/workflows/:deploymentId',
  describeRoute({
    tags: ['Workflows'],
    summary: 'Delete (undeploy) a workflow deployment',
    description:
      'Operator-gated. Soft-deletes the deployment (drops it from list/stream/start), undeploys the sidecar supervisor, and stops its step instances. Optional `?tenantId=` selects a workbench the user belongs to.',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'Deployment id (ses_…) of the workflow to delete.',
        schema: { type: 'string' },
      },
      {
        name: 'tenantId',
        in: 'query',
        required: false,
        description: 'Target workbench tenant id. Omit for the active workbench.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      204: { description: 'Deployment deleted and undeployed' },
      403: {
        description: 'User context not found or forbidden for the requested tenant',
      },
      404: { description: 'Workflow deployment not found' },
    },
  }),
  createWorkflowDeployGrantGuard({ db, grantStore, globalTenantId }),
  deleteWorkflowHandler(workflowDeployCoreDeps)
);

// Abort workflow RUNS (CL-2262), operator-gated by the same session grant guard
// as the deploy/delete-deployment routes — an operator can abort ANY run, so
// there is no per-user ownership check (unlike the user-facing /workflow-exec
// read/resume routes). Marks the run record terminal; CL-2248's boot-reconciler
// reaps the sidecar dir on next restart. `abort-active` is registered before the
// `:runId` route so the literal segment is not captured as a runId.
v1.post(
  '/workflow-exec/records/abort-active',
  abortActiveRunsRouteDescription,
  createWorkflowDeployGrantGuard({ db, grantStore, globalTenantId }),
  abortActiveRunsHandler({ db })
);
v1.delete(
  '/workflow-exec/records/:runId',
  abortRunRouteDescription,
  createWorkflowDeployGrantGuard({ db, grantStore, globalTenantId }),
  abortRunHandler({ db })
);

app.route('/api/v1', v1);

// ─── Internal routes (sidecar token auth) ──────────────────────────

app.route('/api/internal', createInternalApprovalsRouter(db, config.sidecarToken));
app.route(
  '/api/internal',
  createHubToolsRouter(db, config.sidecarToken, {
    sessionService,
    eventCollectors,
    sidecarRouter,
    buildToolDefinitions,
  })
);
app.route('/api/internal', createToolCredentialsRouter(db, config.sidecarToken));
app.route(
  '/api/internal',
  createInternalWorkflowSkillsRouter(db, repoStore.repoStore, config.sidecarToken)
);
app.route('/api/internal', createToolManifestRouter(db, config.sidecarToken, assetService));
app.route(
  '/api/internal',
  createInternalDeploymentsRouter(db, config.sidecarToken, repoStore, config.globalTenant.domain)
);
app.route(
  '/api/internal',
  createWorkflowDeployRouter({
    ...workflowDeployCoreDeps,
    serviceToken: config.sidecarToken,
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
    try {
      log.info('Received {signal}, draining', { signal });
      // Stop accepting new connections first so no WebSocket upgrade can slip in
      // after closeAll (CL-1654).
      await server?.stop();
      // Close sidecar sockets deliberately so each sidecar sees a clean close
      // and reconnects on its short reconnect delay, rather than waiting for its
      // heartbeat to time out the zombie socket left by an abrupt exit (CL-1654).
      log.info('Closing sidecar connections', {
        count: sidecarConnections.size(),
      });
      sidecarConnections.closeAll();
      log.info('Server stopped, exiting');
      process.exit(0);
    } catch (err) {
      log.fatal('Shutdown error', { error: err });
      process.exit(1);
    }
  });
}

process.on('uncaughtException', (err) => {
  // log.fatal routes to the Sentry sink; flush before exiting so the event is
  // not dropped on process death.
  log.fatal('Uncaught exception', { error: err });
  void flushSentry().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal('Unhandled rejection', { error: err });
  // The process keeps running here, but flush so the captured event is not
  // left buffered indefinitely if the process later dies.
  void flushSentry();
});

// Centralized handler for errors thrown out of any route. Logging at error
// level routes to the Sentry sink, so no request error fails silent.
app.onError((err, c) => {
  log.error('Unhandled request error', {
    error: err,
    method: c.req.method,
    path: c.req.path,
  });
  // Flag so serverErrorReporter does not log this 500 a second time.
  c.set(SERVER_ERROR_LOGGED, true);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export { app };

server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
