import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { upgradeWebSocket, websocket } from "hono/bun";
import { schema as intxSchema, createGrantStore } from "@intx/db";
import { createAttachmentCapabilityGuard } from "./attachment-capability-guard";
import { createApp } from "@intx/hub-api";
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
} from "@intx/hub-sessions";
// Per-agent serialized event-collector registry (CL-1656). Drop-in for
// @intx/hub-sessions' createEventCollectorRegistry; serializes onEvent per
// agent so a turn row commits before its parts, fixing the FK race that
// dropped thinking/reply parts.
import { createEventCollectorRegistry } from "@workbench/event-collector";
import {
  createAnalyticsSubscriber,
  createAnalyticsRoutes,
} from "@workbench/analytics";
import { parseInferenceEvent } from "@intx/types/runtime";
import { type } from "arktype";
import { hexEncode } from "@intx/types";
import { createEd25519Crypto } from "@intx/crypto";
import { getLogger } from "@intx/log";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull } from "drizzle-orm";
import { loadConfig } from "./config";
import { createSidecarConnectionRegistry } from "./sidecar-connections";
import {
  createWorkflowDeployGrantGuard,
  createWorkflowDeployRouter,
  deployWorkflowHandler,
  deleteWorkflowHandler,
  tearDownDeployment,
  type WorkflowDeployCoreDeps,
} from "./routes/workflow-deploy";
import {
  createWorkflowRunsRouter,
  deriveWorkflowRunRepoId,
  type EnsureDeploymentRoutableFn,
  type ProvisionRunDeploymentFn,
} from "./routes/workflow-runs";
import { createWorkflowRunRecordsRouter } from "./routes/workflow-run-records";
import { createWorkflowsCatalogRouter } from "./routes/workflows-catalog";
import {
  abortRunHandler,
  abortActiveRunsHandler,
  abortRunRouteDescription,
  abortActiveRunsRouteDescription,
} from "./routes/workflow-run-abort";
import {
  wrapRepoStoreWithProjection,
  type ReclaimRunDeploymentFn,
} from "./workflow-executor/projection-bridge";
import {
  backfillMissingWorkflowFacts,
  projectWorkflowRunFacts,
} from "./workflow-executor/workflow-run-facts";
import { deliverRunTerminalMail } from "./workflow-executor/run-terminal-mail";
import { deliverPendingGateMail } from "./workflow-executor/gate-mail";
import { createWorkflowAnalyticsRouter } from "./routes/workflow-analytics";
import {
  createWorkflowDeployService,
  type ReclaimDeploymentFn,
} from "./services/workflow-deploy";
import {
  createWorkflowReconciler,
  registerAwaitingSupervisorPrewarm,
} from "./services/workflow-reconciler";
import { createRunLivenessSweep } from "./services/run-liveness-sweep";
import { registerStalledScheduledRunReconciler } from "./services/stalled-scheduled-run-reconciler";
import { createWorkflowRunStarter } from "./services/workflow-run-starter";
import { createScheduler } from "./services/scheduler";
import { createInboxIntake } from "./services/inbox-intake";
import { createTaskReconcilerService } from "./services/task-reconciler";
import { createTaskPushService, TASK_ADAPTERS } from "@workbench/tasks";
import { resolveAdapterCredential } from "./lib/task-credential";
import { createDrizzleTaskPushStore } from "./lib/task-push-store";
import { getIdentityAccounts } from "./lib/member-identity";
import { seedHeartbeatSchedules } from "./services/scheduled-trigger-seeder";
import { enrichHeartbeatTriggerPayload } from "./lib/heartbeat-trigger-payload";
import {
  ensureOwnerSchedule,
  listEnabledSchedules,
  markScheduleFired,
  recordScheduleRunStarted,
} from "./lib/scheduled-triggers";
import {
  extractStoredIntake,
  queueScheduledIntakeSignal,
} from "./lib/scheduled-intake";
import { loadWorkflowGateInfos } from "./lib/workflow-catalog";
import { createIdleSessionReaper } from "./services/idle-session-reaper";
import {
  createMailWakeMiddleware,
  registerUndeliveredMailWake,
} from "./services/mail-wake";
import { publishEmbeddedWorkflowDefs } from "./services/workflow-defs-bootstrap";
import { publishEmbeddedToolPackages } from "./services/tool-packages-bootstrap";
import { backfillDenyForExistingWorkflowKinds } from "./lib/workflow-run-gate";
import { createWorkbenchDirectorRegistry } from "@workbench/agents";
import { createUploadsRouter } from "./routes/uploads";
import { createSkillsRouter } from "./routes/skills";
import { createToolsRouter } from "./routes/tools";
import { createAdminRouter } from "./routes/admin";
import { createOwnerRouter } from "./routes/owner";
import { isDemosEnabledByGrant, resolveDemoLinks } from "./lib/demos-gate";
import { isFeatureEnabledForTenantCached } from "./lib/feature-grants";
import { isWorkspaceInboxSourceEnabledForTenant } from "./lib/workspace-inbox-source-gate";
import { isAdmin, isOwner } from "./lib/admin-grant";
import { createAgentProvisioningRouter } from "./routes/agents";
import {
  registerDisconnectReconciler,
  registerWedgeSweepReconciler,
  resolveInstanceSourcesFromDefinition,
  relaunchInstanceIfNeeded,
} from "./services/agent-provisioning";
import { assessPersonalAgentSync } from "./services/grant-reconcile";
import {
  myraInstanceIdForMember,
  syncPersonalAgentForUser,
} from "./services/sync-personal-agent";
import { createMembersRouter } from "./routes/members";
import { createMyraThreadsRouter } from "./routes/myra-threads";
import { createInvokedSubagentsRouter } from "./routes/invoked-subagents";
import {
  recordMyraThreadActivity,
  resolveMyraDefinition,
} from "./services/myra-threads";
import { createGranolaCallFanout } from "./services/granola-call-fanout";
import { createGranolaCallPipeline } from "./services/granola-call-pipeline";
import { createGranolaCallJobQueue } from "./services/granola-call-job-queue";
import { createGranolaCallJobRunner } from "./services/granola-call-job-runner";
import { createGranolaWorkspaceInboxSource } from "./services/inbox-sources/granola-workspace";
import { INBOX_SOURCE_REGISTRY } from "./services/inbox-source-registry";
import {
  createMailboxTriage,
  sweepStaleTriageInstances,
  type MailboxTriage,
} from "./services/mailbox-triage";
import { createArtifactsRouter } from "./routes/artifacts";
import { createFileParseRouter } from "./routes/file-parse";
import { createMailAttachmentsRouter } from "./routes/mail-attachments";
import { createSearchRouter } from "./routes/search";
import { createActorSearchRouter } from "./routes/actor-search";
import { createActorDetailRouter } from "./routes/actor-detail";
import { createActivityRouter } from "./routes/activity";
import { createTenantActivityRouter } from "./routes/tenant-activity";
import { createPricingRouter } from "./routes/pricing";
import { prewarmPriceCatalog } from "./lib/pricing";
import { createPrincipalActivityRouter } from "./routes/principal-activity";
import { createPrincipalRosterRouter } from "./routes/principal-roster";
import { createPrincipalAnalyticsRouter } from "./routes/principal-analytics";
import { createTenantRosterRouter } from "./routes/tenant-roster";
import { createMyraVariantsRouter } from "./routes/myra-variants";
import { createGammaTemplatesRouter } from "./routes/gamma-templates";
import {
  createApprovalsRouter,
  createInternalApprovalsRouter,
} from "./routes/approvals";
import { createApprovalsEventBus } from "./lib/approvals-events";
import { createFeedbackRouter } from "./routes/feedback";
import type { MemberPreferences } from "@workbench/shared";
import { resolveEnabledBriefSources } from "@workbench/shared";
import { createMePreferencesRouter } from "./routes/me-preferences";
import { createMeConnectionsRouter } from "./routes/me-connections";
import { createOAuthCallbackRouter } from "./routes/oauth-callback";
import { createInMemoryPendingStore } from "./lib/oauth-flow";
import { createMeBriefRunRouter } from "./routes/me-brief-run";
import { createMeSchedulesRouter } from "./routes/me-schedules";
import { createMeWebhookTriggersRouter } from "./routes/me-webhook-triggers";
import { createWebhookTriggerFireRouter } from "./routes/webhook-trigger-fire";
import { createLinearWebhookRouter } from "./routes/webhooks-linear";
import { createAttioWebhookRouter } from "./routes/webhooks-attio";
import { createSlackWebhookRouter } from "./routes/webhooks-slack";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import { createMeProfileRouter } from "./routes/me-profile";
import { readMemberPreferences } from "./lib/member-preferences";
import { createPrincipalMailboxPersist } from "./lib/principal-mailbox";
import { deliverMentionMail } from "./lib/mention-mail";
import { deliverWelcomeMail } from "./lib/deliver-welcome-mail";
import { createMailboxEventBus } from "./lib/mailbox-events";
import { createInboxRouter } from "./routes/inbox";
import { createMeTasksRouter } from "./routes/me-tasks";
import { createHubToolsRouter } from "./routes/hub-tools";
import { createToolCredentialsRouter } from "./routes/tool-credentials";
import { createToolManifestRouter } from "./routes/tool-manifest";
import { createInternalDeploymentsRouter } from "./routes/internal-deployments";
import { buildToolDefinitions } from "./lib/tool-registry";
import { schema } from "./db";
import { loadSigningKeyRegistry } from "./lib/signing-keys";
import {
  seedGlobalTenant,
  seedAgentTemplates,
  autoJoinConfiguredTenants,
  lookupMember,
} from "./lib/tenant-provisioning";
import { reconcileMemberInstanceGrants } from "./services/grant-reconcile";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { setupObservability, flushSentry } from "@workbench/sentry";
import {
  serverErrorReporter,
  SERVER_ERROR_LOGGED,
} from "./lib/server-error-logger";
import { createFatalErrorRecovery } from "./lib/fatal-error-recovery";
import { resolveCorsAllowOrigin } from "./lib/cors-origin";
import { createRateLimiter } from "./lib/rate-limit";
import { createSystemRouter } from "./routes/system";

await setupObservability({ dev: process.env.NODE_ENV !== "production" });
const log = getLogger(["api"]);
const meLog = getLogger(["api", "v1-me"]);

const config = loadConfig();

// ─── Database ──────────────────────────────────────────────────────

const sql = postgres(config.databaseUrl);
const db = drizzle(sql, { schema });

await sql`SELECT 1`;
log.info("Database connection established");

// ─── Root tenant bootstrap ─────────────────────────────────────────
//
// Seed the deployment's root tenant — the default home (name/slug/domain from
// env). Idempotent and race-safe across replicas — creates it on first boot,
// returns the existing id thereafter. Fail-loud: if the root tenant cannot be
// seeded the hub must not start, because every same-domain user joins it as a
// principal.
const { tenantId: rootTenantId } = await seedGlobalTenant(db);
log.info("Root tenant ready", { rootTenantId });

// Re-seed agent templates (Myra, Oat, …) into the root tenant on every boot
// so a deploy that changes a template's prompt, tool-package pins, or
// capabilities actually reaches the agent rows. seedGlobalTenant returns early
// when the tenant already exists, so without this the rows stay frozen at
// whatever an earlier manual seed wrote (CL-1530's "seeded at hub boot"
// contract was never wired). Idempotent upsert; fail-loud to surface a
// malformed template at deploy rather than silently shipping stale agents.
await seedAgentTemplates(db, rootTenantId);
log.info("Agent templates seeded", { rootTenantId });

// seedAgentTemplates updates the org agent rows, but existing member instances
// keep the tool grants synthesized at their last launch — provisionMemberInstances
// skips members who already have an instance. So a tool added to a template never
// reaches existing members until each relaunches, surfacing as
// "No matching grants for tool:…/invoke". Reconcile every member instance's grants
// to the freshly-seeded definitions here. DB-only: sidecars reconnect after the
// hub starts and the orchestrator pushes the current DB grants on reconnect.
const reconciled = await reconcileMemberInstanceGrants(
  db,
  rootTenantId,
  AGENT_TEMPLATES,
);
log.info("Member instance grants reconciled", {
  rootTenantId,
  results: reconciled,
});

const { isDev, cors: corsConfig, auth: authConfig, google, hub } = config;

// ─── Auth ──────────────────────────────────────────────────────────
const { origins: corsOrigins, isCrossOrigin } = corsConfig;
const { useCrossSiteCookies } = authConfig;

log.info("CORS config loaded", { corsOrigins, corsCount: corsOrigins.length });

const auth = betterAuth({
  baseURL: authConfig.baseUrl,
  secret: authConfig.secret,
  trustedOrigins: isDev
    ? Array.from({ length: 10 }, (_, i) => `http://localhost:${5173 + i}`)
    : corsOrigins,
  database: drizzleAdapter(db, { provider: "pg" }),
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
  advanced: !isDev
    ? {
        defaultCookieAttributes: useCrossSiteCookies
          ? { sameSite: "none", secure: true }
          : { sameSite: "lax", secure: true },
      }
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
          const domain = user.email.split("@")[1];
          if (!domain || !google.allowedDomains.includes(domain)) {
            throw new Error(`Email domain not allowed`);
          }
        },
        after: async (user) => {
          try {
            const joined = await autoJoinConfiguredTenants(db, user.id);
            if (joined.length > 0) {
              log.info("User auto-joined tenants on signup", {
                userId: user.id,
                slugs: joined.map((j) => j.slug),
              });
            }
          } catch (err) {
            log.error("Auto-join failed for new user", {
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
          try {
            await autoJoinConfiguredTenants(db, session.userId);
          } catch (err) {
            log.error("Session auto-join repair failed — continuing", {
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

const registry = await loadSigningKeyRegistry(hub.signingKeys);
log.info("Loaded signing key registry: active version {version}", {
  version: registry.active.version,
});
const cryptoProvider = createEd25519Crypto(registry.active);

// ─── Agent repo store ──────────────────────────────────────────────

// Per-run deployment teardown (CL-2582). The reclaim callback needs
// `sessionService`, which is constructed below from this very repo store, so it
// is late-bound: the projection bridge calls through this holder, which stays a
// no-op until the wiring below installs the real teardown. A terminal pack can
// only arrive after the sidecar connects and runs — long after startup — so the
// no-op window is never hit in practice, and the janitor reclaims anything that
// somehow slips through.
const reclaimRunDeploymentRef: { fn: ReclaimRunDeploymentFn | undefined } = {
  fn: undefined,
};
const repoStore = wrapRepoStoreWithProjection(
  createAgentRepoStore({
    dataDir: hub.dataDir,
    signingKey: registry.active,
    // Retention is fixed to keep-history: the hub is the long-term archive
    // of an agent's state graph (see the HUB_AGENT_GC_* notes in config.ts).
    gc: { ...hub.agentGc, retention: "keep-history" },
  }),
  {
    db,
    reclaimDeployment: (args) => reclaimRunDeploymentRef.fn?.(args),
    // CL-2670: project a terminal run's analytics facts from its log. Fire-and-
    // forget; the projector owns its errors and must never block pack receipt.
    projectRunFacts: (args) => {
      void projectWorkflowRunFacts(
        { db, repoStore: args.repoStore },
        {
          repoId: args.repoId,
          runId: args.runId,
          kind: args.kind,
          tenantId: args.tenantId,
        },
      ).catch((err: unknown) => {
        // ERROR, not WARN: the WRN level is invisible in Sentry, and a lost
        // projection here permanently drops the run's facts on the live path
        // (the projector only re-fires on a non-terminal → terminal transition).
        // The boot backfill (backfillMissingWorkflowFacts) recovers it on next
        // restart, but the failure must be Sentry-visible now (CL-2670 review).
        log.error("workflow analytics fact projection failed", {
          runId: args.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    },
    // Deliver a "a workflow needs you" mailbox item to the run owner
    // when a run parks on an awaitSignal gate. Fire-and-forget; the deliverer
    // owns its errors and must never block pack receipt.
    deliverGateMail: (args) => {
      void deliverPendingGateMail(
        {
          db,
          repoStore: args.repoStore,
          deploymentDomain: config.rootTenant.domain,
          mailboxEventBus,
        },
        {
          runId: args.runId,
          kind: args.kind,
          tenantId: args.tenantId,
          principalId: args.principalId,
          deploymentId: args.deploymentId,
        },
      ).catch((err: unknown) => {
        log.error("workflow gate mail delivery failed", {
          runId: args.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    },
    // Deliver a "your run finished" mailbox item to the run creator when a
    // run reaches a terminal status. Fire-and-forget; the deliverer owns its
    // errors and must never block pack receipt.
    deliverRunMail: (args) => {
      void deliverRunTerminalMail(
        {
          db,
          deploymentDomain: config.rootTenant.domain,
          mailboxEventBus,
        },
        args,
      ).catch((err: unknown) => {
        log.error("workflow run terminal mail delivery failed", {
          runId: args.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    },
  },
);
// ─── Skill asset substrate ─────────────────────────────────────────

const assetService = createAssetService({ db, repoStore: repoStore.repoStore });

// ─── Hub services ──────────────────────────────────────────────────

const grantStore = createGrantStore(db);

const baseLookups = createHubSessionLookups({ db, agentRepoStore: repoStore });

function isWorkflowRunBootstrapRace(message: string): boolean {
  return /non_fast_forward: ref refs\/heads\/main expected null but found [0-9a-f]{40}/.test(
    message,
  );
}

// Workbench-owned mailbox live-delivery bus (CL-3336). One in-process instance
// shared by every principal_mailbox write path (external mail via persistMail,
// workflow gate mail, and triage handoffs) and the /me/inbox/events SSE route,
// so a connected client is notified the instant any of those write a row —
// never mail content, only {type:"mailbox", id}.
const mailboxEventBus = createMailboxEventBus();

// Late-bound: constructed below once sessionService exists. The persist hook
// and the turn-finalized fan-out both fire only after boot completes, so the
// brief window where this is undefined can never drop a real event.
// eslint-disable-next-line prefer-const -- assigned once, after sessionService below; can't be const at declaration
let mailboxTriage: MailboxTriage | undefined;

const lookups: SidecarLookups = {
  ...baseLookups,
  persistMail: createPrincipalMailboxPersist(db, baseLookups.persistMail, {
    onUserMailboxRow(event) {
      mailboxTriage?.enqueue(event);
      mailboxEventBus.publish(event.memberPrincipalId, {
        type: "mailbox",
        id: event.rowId,
      });
    },
  }),
  async receiveWorkflowRunPack(repoId, pack, ref, commitSha) {
    if (repoId.kind !== "workflow-run") {
      throw new Error(
        `hub-session lookups receiveWorkflowRunPack received unsupported repo kind ${JSON.stringify(repoId.kind)}`,
      );
    }
    const deploymentId = repoId.id;
    try {
      await repoStore.receiveWorkflowRunPack(
        { kind: "workflow-run", id: deploymentId },
        pack,
        ref,
        commitSha,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("path_violation")) {
        log.warn("Workflow-run pack rejected for {deploymentId}: {message}", {
          deploymentId,
          message: msg,
        });
        return { accepted: false, reason: "path_violation" as const };
      }
      if (isWorkflowRunBootstrapRace(msg)) {
        log.warn(
          "Workflow-run pack bootstrap race for {deploymentId}: {message}",
          {
            deploymentId,
            message: msg,
          },
        );
        return { accepted: false, reason: "corrupt" as const };
      }
      log.error(
        "Workflow-run pack receive failed for {deploymentId}: {message}",
        {
          deploymentId,
          message: msg,
        },
      );
      return { accepted: false, reason: "corrupt" as const };
    }
    return { accepted: true };
  },
};

const sidecarRouter = createSidecarRouter({
  hubPublicKey: hexEncode(registry.active.publicKey),
  lookups,
});

const analyticsSubscriber = createAnalyticsSubscriber({ db });

sidecarRouter.events.on("agent.event", ({ agentAddress, event }) => {
  const validated = parseInferenceEvent(event);
  if (validated instanceof type.errors) {
    log.warn("Skipping analytics for invalid agent event: {summary}", {
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
      type: "turn.committed",
      data: {
        turnId: turn.turnId,
        status: turn.status,
        text: turn.text,
        hadReply: turn.hadReply,
        hadError: turn.hadError,
        errors: turn.errors,
        toolCalls: turn.toolCalls,
        toolErrors: turn.toolErrors,
        reasoning: turn.reasoning,
      },
    });

    fatalErrorRecovery(agentAddress, turn);
    mailboxTriage?.handleTurnFinalized(agentAddress, turn);
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

// Ephemeral Myra triage of external inbound user mail (kill switch:
// TRIAGE_ENABLED). Fed by the persistMail hook above; turn results arrive via
// the event-collector onTurnFinalized fan-out above.
mailboxTriage = createMailboxTriage({
  db,
  sessionService,
  grantStore,
  eventCollectors,
  cryptoProvider,
  mailboxEventBus,
});

// Retires any `myra-triage` instances a prior process left behind because
// their `endSession` call failed mid-teardown (see `runOne`'s finally block
// in mailbox-triage.ts). Bounded, logged once, fire-and-forget — a failure
// here just leaves the backlog for the next boot to retry.
// Delayed past the sidecar's typical post-boot reconnect window so the
// undeploy calls have a live sidecar to land on; a still-disconnected
// sidecar just defers rows to the next boot.
const TRIAGE_SWEEP_BOOT_DELAY_MS = 5 * 60_000;
setTimeout(() => {
  void sweepStaleTriageInstances(db, sessionService).catch((err) => {
    log.error("Triage boot sweep failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });
}, TRIAGE_SWEEP_BOOT_DELAY_MS).unref();

// The disconnect reconciler above only ENDS a stale session; nothing re-registers
// the address, because the router has no `sidecar.connect` counterpart to the
// `sidecar.disconnect` it listens on. A sidecar that fully restarts (every
// redeploy) reconnects with no agents, so an instance is left active-but-
// unroutable and mail 502s until fixed by hand. This periodic sweep supplies the
// missing RELAUNCH half on a cadence, healing the wedge from any cause (missed
// disconnect event, hub restart). It composes with the disconnect reconciler:
// both re-read getRoutableAddresses right before acting and every relaunch is
// funneled through the process-local dedup breaker, so they cannot double-launch.
//
// ASSUMES A SINGLE HUB REPLICA — same caveat as registerDisconnectReconciler:
// the routability read is this hub's local router state. (CL-2639)
const stopWedgeSweepReconciler = registerWedgeSweepReconciler({
  db,
  router: sidecarRouter,
  sessionService,
  grantStore,
  eventCollectors,
  intervalMs: config.wedgeSweepIntervalMs,
  graceMs: config.wedgeUnroutableGraceMs,
});

// CL-2790: idle chat-session reaper. Sleeps a user-facing chat session (Myra,
// Oat, …) that has seen no activity for `reapAfterMs` by undeploying it and
// marking its session ended, leaving the instance relaunchable so the next
// chat-surface open cold-relaunches it via POST /v1/instances/:id/sessions
// (CL-2793 removed the former eager /v1/me relaunch). CL-2795 made it always-on:
// an in-flight-turn guard (the injected eventCollectors registry) spares any
// agent mid-work, so the kill switch is gone. Fed by the agent-event stream and
// the send-mail route (recordActivityForInstance, mounted below) so a
// mid-conversation agent is never slept. The former post-reconnect
// personal-agent prewarm sweep that used to relaunch every recently-active
// personal instance in the background: no agent auto-wakes anymore except on
// inbound mail/message (see the mail-route wake middleware below), so nothing
// should relaunch an idle instance the reaper is entitled to sleep.
const idleSessionReaper = createIdleSessionReaper({
  db,
  endSession: sessionService.endSession,
  getRoutableAddresses: sidecarRouter.getRoutableAddresses,
  eventCollectors,
  reapAfterMs: config.idleSessionReaper.reapAfterMs,
  intervalMs: config.idleSessionReaper.intervalMs,
});
// TEMPORARILY DISABLED: CL-2790/CL-2795 idle reaper breaks chat-history reload
// and causes session_asset unique-constraint launch failures on relaunch.
// idleSessionReaper.start();
sidecarRouter.events.on("agent.event", ({ agentAddress }) => {
  idleSessionReaper.recordActivity(agentAddress);
});

// The single wake primitive for both inbound-mail ingresses (the HTTP
// mail route and agent-to-agent WS mail). A no-op for an already-routable
// instance; the same cold-start relaunch used by the wedge sweep and the
// chat-surface sessions route.
function wakeInstance(instanceId: string): Promise<void> {
  return relaunchInstanceIfNeeded(
    db,
    sessionService,
    grantStore,
    eventCollectors,
    instanceId,
    sidecarRouter,
  );
}

// Agent-to-agent mail to a reaped instance: a sidecar-originated mail.outbound
// frame is routed wire-side inside interchange; a slept recipient is absent
// from the address index, so the router emits `mail.outbound.undelivered` and
// the orchestrator's default listener drops it with a warn. Subscribe the hub
// to the same event (listeners are additive), wake the recipient instance, and
// re-deliver via the router's public routeMail.
registerUndeliveredMailWake({
  db,
  wake: wakeInstance,
  onUndelivered: (handler) =>
    sidecarRouter.events.on("mail.outbound.undelivered", handler),
  routeMail: sidecarRouter.routeMail,
});

// Per-run deployment teardown (CL-2582), shared by the projection bridge
// (terminal teardown), the deploy service (provision-failure rollback), and the
// reconciler janitor (crash-orphan reclaim). All run state needed for history is
// already in `workflow_run_record` before this fires, so reclaiming the
// ephemeral per-run deployment loses nothing.
const reclaimDeployment: ReclaimDeploymentFn = ({
  deploymentId,
  tenantId,
  reason,
}) =>
  tearDownDeployment({
    db,
    sessionService,
    deploymentDomain: config.rootTenant.domain,
    deploymentId,
    tenantId,
    reason,
  });

// Install the projection-bridge hook: when a run reaches a terminal status the
// bridge fires this to tear its single-use deployment down. Fire-and-forget with
// a logged catch — teardown is best-effort and must never block pack receipt; a
// miss is reclaimed by the janitor.
reclaimRunDeploymentRef.fn = ({ deploymentId, tenantId, runId }) => {
  void reclaimDeployment({
    deploymentId,
    tenantId,
    reason: `run ${runId} reached terminal status`,
  }).catch((err) => {
    log.warn("per-run deployment teardown failed", {
      deploymentId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
    const allowedOrigin = resolveCorsAllowOrigin(
      c.req.header("Origin"),
      corsOrigins,
    );
    if (allowedOrigin)
      headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
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
        if (typeof evt.data === "string") {
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

// Active tenant membership is enforced by createApp's resolveTenant on
// /api/tenants/:tenantId/* (org members have no role grants).
hubApp.route("/api/tenants/:tenantId/analytics", createAnalyticsRoutes({ db }));
hubApp.route("/api/tenants/:tenantId/activity", createActivityRouter({ db }));
hubApp.route(
  "/api/tenants/:tenantId/activity",
  createTenantActivityRouter({ db }),
);
hubApp.route("/api/tenants/:tenantId/pricing", createPricingRouter({ db }));

// CL-2749: pre-warm the shared models.dev pricing cache on boot so the first
// post-deploy Insights pricing request is served warm instead of eating the
// fetch latency (or a 503). Detached and fail-safe — prewarmPriceCatalog owns
// its errors, so this never blocks or fails startup if models.dev is down.
void prewarmPriceCatalog();
hubApp.route(
  "/api/tenants/:tenantId/principals/:principalId/activity",
  createPrincipalActivityRouter({ db }),
);
hubApp.route(
  "/api/tenants/:tenantId/principals/:principalId/roster",
  createPrincipalRosterRouter({ db }),
);
hubApp.route(
  "/api/tenants/:tenantId/principals/:principalId/analytics",
  createPrincipalAnalyticsRouter({ db }),
);
hubApp.route("/api/tenants/:tenantId", createMyraVariantsRouter(db));
hubApp.route("/api/tenants/:tenantId/roster", createTenantRosterRouter({ db }));
hubApp.route("/api/tenants/:tenantId/search", createSearchRouter({ db }));
hubApp.route(
  "/api/tenants/:tenantId/actors/search",
  createActorSearchRouter({ db }),
);
hubApp.route(
  "/api/tenants/:tenantId/actors/:principalId",
  createActorDetailRouter({ db }),
);

// ─── Parent Hono ────────────────────────────────────────────────────

const app = new Hono<{ Variables: { [SERVER_ERROR_LOGGED]?: boolean } }>();

app.use("*", honoLogger());

// Report any >= 500 response — including handled errors returned via c.json
// that never throw — to the error log / Sentry sink.
app.use("*", serverErrorReporter());

if (corsOrigins.length > 0) {
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );
}

// Brute-force defense on credential sign-in. Single-process in-memory limiter;
// infra-level limiting across replicas is still expected in production.
app.use(
  "/api/auth/sign-in/*",
  createRateLimiter({ windowMs: 60_000, max: 10 }),
);

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
  "/openapi.json",
  openAPIRouteHandler(app, {
    documentation: {
      info: { title: "GTM Workbench", version: "1.0.0" },
      servers: [{ url: config.auth.baseUrl }],
    },
    exclude: ["/openapi.json", /^\/api\/auth\//],
  }),
);

// Mail-only wake. The idle-session reaper (CL-2790) now sleeps EVERY
// agent kind, not just Myra — so a shared/sub-agent's next inbound message can
// land on an instance whose session the reaper already ended (address no
// longer routable). Interchange's own `/:instanceId/mail` route (mounted
// below, out of scope to modify) only checks `status === "running"` and a
// non-null `sessionId` — both still true after a reaper sleep — and never
// relaunches, so without this the request would 502 with no self-heal. Wake
// on-demand, ahead of that route, with the same cold-start relaunch used by
// the wedge sweep and the chat-surface sessions route
// (`relaunchInstanceIfNeeded` — a no-op when the instance is already
// routable or has no active-session gap to fill).
app.use(
  "/api/tenants/:tenantId/agents/instances/:instanceId/mail",
  createMailWakeMiddleware(wakeInstance),
);

// Server-side backstop for the per-agent attachment gate: reject a document
// the instance's adapter can't consume before interchange's mail route stores
// it. Registered before the hub app so it runs ahead of that route.
app.use(
  "/api/tenants/:tenantId/agents/instances/:instanceId/mail",
  createAttachmentCapabilityGuard(db),
);

// CL-2790: activity on the mail route bumps the idle-reaper clock for the
// target instance so a user mid-conversation (or reading it — hydration GETs
// count) is never slept. Thread activity (lastActivityAt ordering + the
// first_message_at first-use stamp, CL-3749) is recorded ONLY for message
// sends: the session-hydration GET hits this same path, and stamping there
// would mark a just-opened empty chat as used before any message exists —
// exactly what the deferred sidebar insert must not do. Best-effort and
// non-blocking: both side effects are fire-and-forget and we always fall
// through to the mail route.
app.use(
  "/api/tenants/:tenantId/agents/instances/:instanceId/mail",
  async (c, next) => {
    const instanceId = c.req.param("instanceId");
    if (instanceId) {
      void idleSessionReaper.recordActivityForInstance(instanceId);
      if (c.req.method === "POST") {
        void recordMyraThreadActivity(db, instanceId).catch((err) => {
          log.error("failed to record Myra thread activity", {
            instanceId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        });
      }
    }
    await next();
  },
);

// Chat mentions (`@[Name](#usr_<id>)` tokens in the outbound message) are
// delivered as mail to each mentioned member's principal mailbox — see
// deliverMentionMail. This runs on the same mail-send route as the
// activity-recording middleware above, ahead of the hub app mount, since
// interchange's own /:instanceId/mail route (mounted below) owns the actual
// send and is out of scope to modify. Best-effort and fire-and-forget: a
// failure here is logged by deliverMentionMail and never blocks or slows the
// chat send.
const ChatMentionBody = type({ content: "string" });
const conversationBaseUrl = corsOrigins[0] ?? config.auth.baseUrl;
app.use(
  "/api/tenants/:tenantId/agents/instances/:instanceId/mail",
  async (c, next) => {
    const tenantId = c.req.param("tenantId");
    // POST-only (this path also serves GET list-mail polling), and bounded
    // before the clone-and-parse so an oversized payload is never read here —
    // the real send route enforces its own body limit downstream.
    const contentLength = Number(c.req.header("content-length") ?? "0");
    const withinSizeLimit =
      Number.isFinite(contentLength) && contentLength <= 1_000_000;
    if (tenantId && c.req.method === "POST" && withinSizeLimit) {
      void (async () => {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        if (!session) return;
        let body: unknown;
        try {
          body = await c.req.raw.clone().json();
        } catch {
          return;
        }
        const parsed = ChatMentionBody(body);
        if (parsed instanceof type.errors) return;
        await deliverMentionMail({
          db,
          tenantId,
          senderUserId: session.user.id,
          senderName: session.user.name ?? session.user.email ?? "A teammate",
          content: parsed.content,
          conversationUrl: `${conversationBaseUrl}/inbox`,
          mailboxEventBus,
        });
      })().catch((err) => {
        log.error("mention mail dispatch failed", {
          tenantId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }
    await next();
  },
);

// Mount hub app
app.route("/", hubApp);

// ─── Workbench routes ──────────────────────────────────────────────

// Workbench-owned approvals change bus (CL-3285). One in-process instance shared
// by the user-facing router (SSE stream + resolve emits) and the internal router
// (create emit) so a sidecar-created approval reaches an open browser stream.
const approvalsEventBus = createApprovalsEventBus();

const v1 = new Hono<{ Variables: { userId: string; userName: string } }>();

v1.use("*", async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId", result.user.id);
  c.set("userName", result.user.name ?? result.user.email ?? "Unknown");
  await next();
});

const MePostBody = type({
  "syncPersonalAgent?": "boolean",
});

v1.get("/me", async (c) => {
  const userId = c.get("userId");
  const userName = c.get("userName");

  const membership = await lookupMember(db, {
    tenantId: rootTenantId,
    userId,
  });
  const workingTenantId = membership?.tenantId ?? null;
  const memberPrincipalId = membership?.principalId ?? null;

  let paInstanceId: string | null = null;
  if (workingTenantId && memberPrincipalId) {
    paInstanceId = await myraInstanceIdForMember(
      db,
      workingTenantId,
      memberPrincipalId,
    );
  }

  const syncAssessment = await assessPersonalAgentSync(db, paInstanceId);
  const personalAgentSyncAvailable = syncAssessment.available;
  if (personalAgentSyncAvailable) {
    meLog.info("GET /v1/me recommends personal agent sync", {
      userId,
      paInstanceId,
      reason: syncAssessment.reason,
    });
  }

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
            paInstance.modelPreferences,
          );
          credentialResolved = resolution.ok && resolution.sources.length > 0;
        }
      } catch (err) {
        log.warn("Instance source resolution failed on /me", {
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
      .innerJoin(
        intxSchema.tenant,
        eq(intxSchema.tenant.id, intxSchema.principal.tenantId),
      )
      .where(
        and(
          eq(intxSchema.principal.refId, userId),
          eq(intxSchema.principal.kind, "user"),
          isNull(intxSchema.tenant.parentId),
        ),
      );
    for (const row of rootPrincipals) {
      rootTenantIds.push(row.tenantId);
    }
  } catch (err) {
    // non-fatal — frontend falls back to filtering only personalTenantId
    log.warn("Root tenant lookup failed on /me", { error: err, userId });
  }

  // Fold persisted UI preferences into the bootstrap so the web client needs no
  // separate request (no theme flash on load).
  let preferences: MemberPreferences = {};
  if (workingTenantId && memberPrincipalId) {
    preferences = await readMemberPreferences(
      db,
      workingTenantId,
      memberPrincipalId,
    );
  }

  // Whether the caller can see the Admin area, resolved through Interchange's
  // native grant model (owner/admin roles hold the wildcard grants the admin
  // gate probes). Cosmetic only — the hub admin routes re-check server-side.
  // `workingTenantId` is the caller's membership in `rootTenantId` (the global
  // org tenant), so this authorizes over the SAME tenant the admin route guard
  // uses (`rootTenantId`) — the nav gate and the real gate cannot diverge.
  let admin = false;
  let owner = false;
  if (memberPrincipalId && workingTenantId) {
    admin = await isAdmin(grantStore, memberPrincipalId, workingTenantId);
    // Owner is a strict superset of admin (see isOwner): ABK Labs owners hold
    // the `owner` role (`*`/`*`); customer-side admins do not. Drives the
    // `/owner` nav gate — the owner routes re-check server-side.
    owner = await isOwner(grantStore, memberPrincipalId, workingTenantId);
  }

  // Demos are hidden by default. The links are resolved server-side and only
  // included when demos are enabled (env override OR org-wide grant), so the
  // list never reaches the client while disabled. The env flag short-circuits
  // the grant lookup so this bootstrap hot path skips two DB queries when
  // SHOW_DEMOS is on.
  const demosGrantEnabled = config.showDemos
    ? false
    : await isDemosEnabledByGrant(db, rootTenantId);
  const demoLinks = resolveDemoLinks(config.showDemos, demosGrantEnabled);

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
    personalAgentSyncAvailable,
    isAdmin: admin,
    isOwner: owner,
    preferences,
    demoLinks,
  });
});

v1.post("/me", async (c) => {
  const userId = c.get("userId");
  const userName = c.get("userName");

  const raw = await c.req.json().catch(() => ({}));
  const parsed = MePostBody(raw);
  if (parsed instanceof type.errors) {
    return c.json({ error: parsed.summary }, 400);
  }
  const syncPersonalAgent = parsed.syncPersonalAgent ?? true;

  meLog.info("POST /v1/me personal agent sync started", {
    userId,
    syncPersonalAgent,
  });

  const syncOutcome = await syncPersonalAgentForUser(
    { db, rootTenantId, grantStore, sidecarRouter },
    userId,
  );
  const { workingTenantId, memberPrincipalId, paInstanceId } = syncOutcome;

  // Called on every /me bootstrap, not gated on `provisionedMyra`:
  // `deliverWelcomeMail` itself is the idempotency boundary (guards on the
  // `onboarding.welcomeSentAt` preference), so a transient failure on the
  // member's actual first login still gets a retry on their next one instead
  // of being silently missed forever.
  if (workingTenantId && memberPrincipalId && paInstanceId) {
    await deliverWelcomeMail({
      db,
      tenantId: workingTenantId,
      memberPrincipalId,
      myraInstanceId: paInstanceId,
      mailboxEventBus,
    });
  }

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
            paInstance.modelPreferences,
          );
          credentialResolved = resolution.ok && resolution.sources.length > 0;
        }
      } catch (err) {
        log.warn("Instance source resolution failed on POST /me", {
          error: err,
          tenantId: workingTenantId,
        });
        credentialResolved = false;
      }
    }
  }

  const rootTenantIds: string[] = [];
  try {
    const rootPrincipals = await db
      .select({ tenantId: intxSchema.principal.tenantId })
      .from(intxSchema.principal)
      .innerJoin(
        intxSchema.tenant,
        eq(intxSchema.tenant.id, intxSchema.principal.tenantId),
      )
      .where(
        and(
          eq(intxSchema.principal.refId, userId),
          eq(intxSchema.principal.kind, "user"),
          isNull(intxSchema.tenant.parentId),
        ),
      );
    for (const row of rootPrincipals) {
      rootTenantIds.push(row.tenantId);
    }
  } catch (err) {
    log.warn("Root tenant lookup failed on POST /me", { error: err, userId });
  }

  const postAssessment = await assessPersonalAgentSync(db, paInstanceId);
  const personalAgentSyncAvailable = postAssessment.available;

  meLog.info("POST /v1/me personal agent sync finished", {
    userId,
    paInstanceId,
    provisionedMyra: syncOutcome.provisionedMyra,
    grantsRefreshed: syncOutcome.grantsRefreshed,
    grantsPushedLive: syncOutcome.grantsPushedLive,
    stillNeedsSync: personalAgentSyncAvailable,
    remainingReason: postAssessment.reason,
  });

  // Fold persisted UI preferences into the bootstrap response (the web client
  // calls POST /me at startup) so reads cost no extra round-trip.
  let preferences: MemberPreferences = {};
  if (workingTenantId && memberPrincipalId) {
    preferences = await readMemberPreferences(
      db,
      workingTenantId,
      memberPrincipalId,
    );
  }

  return c.json({
    userId,
    userName,
    personalTenantId: workingTenantId,
    rootTenantIds,
    paInstanceId,
    provisioned: workingTenantId !== null,
    credentialResolved,
    personalAgentSyncAvailable,
    preferences,
  });
});

// Shared across the `/me/tasks/:id/push` route and the background reconciler
// so concurrent pushes for the same (task, adapter, operation) — whether both
// from the route, both from the reconciler, or one of each — coalesce onto
// one in-process in-flight map instead of two independent guards that never
// see each other's work.
const taskPushService = createTaskPushService({
  store: createDrizzleTaskPushStore(db),
  adapters: TASK_ADAPTERS,
  resolveCredential: resolveAdapterCredential(db),
  resolveAssignee: async (ownerPrincipalId, adapterId, tenantId) => {
    const provider = TASK_ADAPTERS[adapterId]?.providerName;
    if (provider === undefined) return null;
    const accounts = await getIdentityAccounts(db, tenantId, ownerPrincipalId, [
      provider,
    ]);
    return accounts[0]?.value ?? null;
  },
});

v1.route(
  "/",
  createAgentProvisioningRouter(
    db,
    sessionService,
    grantStore,
    sidecarRouter,
    eventCollectors,
  ),
);
v1.route("/", createMembersRouter(db));
v1.route("/", createMyraThreadsRouter(db, sessionService, analyticsSubscriber));
v1.route("/", createInvokedSubagentsRouter(db));
v1.route("/", createArtifactsRouter(db, grantStore));
v1.route("/", createFileParseRouter(db));
v1.route("/", createMailAttachmentsRouter(db));
v1.route("/", createGammaTemplatesRouter(db));
v1.route("/", createApprovalsRouter(db, approvalsEventBus));
v1.route("/", createFeedbackRouter(db));
v1.route("/", createMePreferencesRouter(db, grantStore));
// Per-user OAuth connections (CL-3356). The PKCE verifier store is shared with
// the public callback router below so an authorize on one request and its
// callback on another find the same server-side verifier. `state` is signed
// with the better-auth secret (always present) so the cookie-less callback can
// trust the member principal it carries.
const oauthPendingStore = createInMemoryPendingStore();
// Where the browser lands after the flow (web app Connections page).
const oauthRedirectBase = `${(config.cors.origins[0] ?? config.auth.baseUrl).replace(/\/$/, "")}/settings/connections`;
// The hub's own public origin — the OAuth redirect_uri is derived from it and
// must match what the owner registers with the provider.
const oauthRedirectUriBase = new URL(config.auth.baseUrl).origin;
// The OAuth `state` HMAC is signed with OAUTH_STATE_SECRET (a DEDICATED secret,
// deliberately NOT BETTER_AUTH_SECRET — do not collapse them), resolved lazily
// per request inside the routers so a deployment that has not enabled
// OAuth-for-inbox still starts.
v1.route(
  "/",
  createMeConnectionsRouter({
    db,
    grantStore,
    pendingStore: oauthPendingStore,
    redirectUriBase: oauthRedirectUriBase,
  }),
);
v1.route("/", createInboxRouter(db, mailboxEventBus));
v1.route("/", createMeTasksRouter(db, taskPushService, mailboxEventBus));

// Resolves a member principal to the user mail identity trigger payloads
// carry (`usr_<refId>@<domain>` via deriveUserMailAddress, the one canonical
// principal-mailbox address format). Shared by the schedules route
// (server-side identity, never client-supplied) and the boot-time heartbeat
// seeder.
const resolveUserIdentity = async (
  memberPrincipalId: string,
): Promise<{
  userAddress: string;
  userRefId: string;
  userDisplayName?: string;
}> => {
  const member = await db.query.principal.findFirst({
    where: eq(intxSchema.principal.id, memberPrincipalId),
  });
  if (!member) {
    throw new Error(`principal not found: ${memberPrincipalId}`);
  }
  const authUser =
    member.kind === "user"
      ? await db.query.user.findFirst({
          where: eq(intxSchema.user.id, member.refId),
        })
      : undefined;
  return {
    userAddress: deriveUserMailAddress({
      userRefId: member.refId,
      domain: config.rootTenant.domain,
    }),
    userRefId: member.refId,
    ...(authUser?.name !== undefined ? { userDisplayName: authUser.name } : {}),
  };
};

v1.route("/", createMeSchedulesRouter(db, resolveUserIdentity));
v1.route("/", createMeWebhookTriggersRouter(db));
v1.route("/", createMeProfileRouter(auth));
v1.route("/", createUploadsRouter(db));
v1.route("/", createSkillsRouter(db, assetService, repoStore.repoStore));
v1.route("/", createToolsRouter(db, assetService));
v1.route(
  "/",
  createAdminRouter({ db, grantStore, assetService, rootTenantId }),
);
v1.route(
  "/",
  createOwnerRouter({
    db,
    grantStore,
    rootTenantId,
    showDemos: config.showDemos,
    featureEnvOverrides: {
      scheduler: config.scheduler.enabled,
      triage: config.triageEnabled,
      "tasks-reconciler": config.tasksReconciler.enabled,
    },
  }),
);
// Built before the runs router so the run-start/signal handlers and the
// reconciler can share its idempotent `ensureDeploymentRoutable` re-establish
// primitive.
const workflowDeployService = createWorkflowDeployService({
  db,
  repoStore,
  sidecarRouter,
  sessionService,
  directorRegistry: createWorkbenchDirectorRegistry(),
  reclaimDeployment,
});

const hubPublicKeyHex = hexEncode(registry.active.publicKey);

// Pre-bind the re-establish primitive over the deployment domain so callers
// pass only the per-deployment identity. Idempotent and coalesced per
// deploymentId inside the service.
const ensureDeploymentRoutable: EnsureDeploymentRoutableFn = (args) =>
  workflowDeployService.ensureDeploymentRoutable({
    ...args,
    deploymentDomain: config.rootTenant.domain,
  });

const provisionRunDeployment: ProvisionRunDeploymentFn = (args) =>
  workflowDeployService.provisionRunDeployment({
    ...args,
    deploymentDomain: config.rootTenant.domain,
    hubPublicKey: hubPublicKeyHex,
  });

// Callable run-start: shared by the HTTP start handler and the
// scheduler, so a scheduled run fires through the same resolution +
// routability + mail-trigger delivery as an HTTP-initiated one.
const runStarter = createWorkflowRunStarter({
  db,
  sessionService,
  ensureDeploymentRoutable,
  deploymentDomain: config.rootTenant.domain,
  cryptoProvider,
});

// Public webhook firing surface: no session, authenticated only by
// the per-trigger secret. Mounted directly on the parent app, outside the v1
// session-auth wall.
app.route("/", createWebhookTriggerFireRouter({ db, runStarter }));

// Public Linear webhook receiver (CL-3585): additive low-latency intake
// alongside the poller. Mounted only when a signing secret is configured; the
// request is authenticated by the `linear-signature` HMAC, not a session.
if (config.inboxIntake.linearWebhookSecret) {
  app.route(
    "/",
    createLinearWebhookRouter({
      db,
      secret: config.inboxIntake.linearWebhookSecret,
      listMembers: () => listInboxMembers(),
      isSourceEnabledForTenant: (tenantId, sourceKey) =>
        isWorkspaceInboxSourceEnabledForTenant(db, tenantId, sourceKey),
      mailboxEventBus,
      mailboxTriage,
    }),
  );
}

// Public Attio webhook receiver (CL-3586): same additive pattern as Linear —
// mounted only when a signing secret is configured, authenticated by the
// `Attio-Signature` HMAC. Task events reuse the poller's upsert.
if (config.inboxIntake.attioWebhookSecret) {
  app.route(
    "/",
    createAttioWebhookRouter({
      db,
      secret: config.inboxIntake.attioWebhookSecret,
      listMembers: () => listInboxMembers(),
      isSourceEnabledForTenant: (tenantId, sourceKey) =>
        isWorkspaceInboxSourceEnabledForTenant(db, tenantId, sourceKey),
    }),
  );
}

// Public Slack Events API receiver (CL-3581): mentions of mapped members land
// in their inbox. Mounted only when the app signing secret is configured;
// authenticated by the `X-Slack-Signature` v0 HMAC.
if (config.inboxIntake.slackSigningSecret) {
  app.route(
    "/",
    createSlackWebhookRouter({
      db,
      signingSecret: config.inboxIntake.slackSigningSecret,
      listMembers: () => listInboxMembers(),
      isSourceEnabledForTenant: (tenantId, sourceKey) =>
        isWorkspaceInboxSourceEnabledForTenant(db, tenantId, sourceKey),
      mailboxEventBus,
      mailboxTriage,
    }),
  );
}

// Public OAuth callback (CL-3356). Outside the v1 session-auth wall — a provider
// redirect is a top-level browser navigation authenticated by the signed state,
// not a session cookie. Shares the pending PKCE store with the authorize route.
app.route(
  "/",
  createOAuthCallbackRouter({
    db,
    grantStore,
    pendingStore: oauthPendingStore,
    redirectBase: oauthRedirectBase,
    redirectUriBase: oauthRedirectUriBase,
  }),
);

// Member-initiated brief-on-demand: lets a member fire their own heartbeat
// brief outside its daily schedule.
v1.route(
  "/",
  createMeBriefRunRouter({
    db,
    runStarter,
    heartbeatKind: config.scheduler.heartbeatKind,
    resolveUserIdentity,
  }),
);

v1.route(
  "/",
  createWorkflowRunsRouter({
    db,
    repoStore: repoStore.repoStore,
    sidecarRouter,
    sessionService,
    cryptoProvider,
    deploymentDomain: config.rootTenant.domain,
    ensureDeploymentRoutable,
    runStarter,
  }),
);

// Workflow runs (CL-2243): /workflow-exec start/resume drive the SIDECAR
// supervisor (definition deployed like an agent) and persist run state to a
// workflow_run_record row the UI polls; the projection bridge wrapped around
// repoStore folds the sidecar's run events into that row.
// Workflow analytics facts (CL-2670): aggregate insights + per-run breakdown,
// derived from the run event logs by the fact projector. Owner/tenant-gated by
// userId context, mounted alongside the /workflow-exec routes.
v1.route("/", createWorkflowAnalyticsRouter(db));

v1.route(
  "/",
  createWorkflowRunRecordsRouter({
    db,
    repoStore,
    sidecarRouter,
    sessionService,
    cryptoProvider,
    deploymentDomain: config.rootTenant.domain,
    ensureDeploymentRoutable,
    provisionRunDeployment,
    reclaimDeployment,
    // CL-2707: bounded wait for the sidecar during the deploy window so a
    // start/resume that lands before the sidecar reconnects gets an honest 503
    // (auto-retryable) instead of an instant raw 500/503. Single-shared-sidecar
    // invariant: this deployment runs exactly one sidecar, so any connected
    // sidecar IS the sidecar — a non-empty getConnectedSidecars() means ready.
    isSidecarConnected: () => sidecarRouter.getConnectedSidecars().length > 0,
    onUserStoppedRunFacts: (args) => {
      if (args.deploymentId === null) return;
      void projectWorkflowRunFacts(
        { db, repoStore },
        {
          repoId: {
            kind: "workflow-run",
            id: deriveWorkflowRunRepoId({
              deploymentId: args.deploymentId,
              deploymentDomain: config.rootTenant.domain,
            }),
          },
          runId: args.runId,
          kind: args.kind,
          tenantId: args.tenantId,
          indexStatus: "stopped",
        },
      ).catch((err: unknown) => {
        log.error("workflow analytics fact projection failed (user stop)", {
          runId: args.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    },
  }),
);

v1.route("/", createWorkflowsCatalogRouter({ db, repoStore }));

// Hub-as-control-plane reconciler (CL-2224): re-establish workflow supervisors
// from DB + workflow-repo state on startup and on every sidecar reconnect, so
// runs survive hub/sidecar restarts. Idempotent — a no-op when supervisors are
// already routable.
const workflowReconciler = createWorkflowReconciler({
  db,
  events: sidecarRouter.events,
  ensureDeploymentRoutable,
  getRoutableAddresses: sidecarRouter.getRoutableAddresses,
  deploymentDomain: config.rootTenant.domain,
  reclaimDeployment,
  sendAgentUndeploy: sidecarRouter.sendAgentUndeploy,
  sendSignalDeliver: sidecarRouter.sendSignalDeliver,
  hibernationGraceMs: config.workflowHibernationGraceMs,
});
workflowReconciler.start();
// CL-2727: continuous liveness sweep. Where failOrphanedRuns runs ONCE at boot,
// this marks runs whose supervisor dies while the hub stays up (lost pack / dead
// child) — via a compare-and-set that can only ever flip a STILL-`running` run,
// never an `awaiting` one (the CL-2575 invariant).
const runLivenessSweep = createRunLivenessSweep({
  db,
  getRoutableAddresses: sidecarRouter.getRoutableAddresses,
  deploymentDomain: config.rootTenant.domain,
  stallGraceMs: config.runLivenessSweep.stallGraceMs,
  startHardDeadlineMs: config.runLivenessSweep.startHardDeadlineMs,
  intervalMs: config.runLivenessSweep.intervalMs,
});
runLivenessSweep.start();
// CL-2756: periodic backstop that re-establishes gate-parked (`awaiting`)
// supervisors that are unroutable, so a human's gate-resume finds the supervisor
// already routable and pays no re-establish + child re-spawn on the critical
// path. The reconnect-driven reconcileAll (above) covers the case where a
// sidecar restart restores some session and fires `agent.reconnected`; this
// backstop covers the case where NO reconnect event fires (an all-inline/
// deterministic deployment restores no session, or a missed event). Strictly
// awaiting-scoped — a running run is never resurrected here (the liveness sweep
// owns that decision).
const stopAwaitingSupervisorPrewarm = registerAwaitingSupervisorPrewarm({
  reconciler: workflowReconciler,
  intervalMs: config.awaitingSupervisorPrewarmIntervalMs,
});
// CL-3509: fail scheduler-fired runs parked at a gate past the timeout. A
// scheduled run has no human to answer a gate — its `intake` is auto-delivered —
// so one still `awaiting` long after its last log advance is wedged and is failed
// legibly instead of lingering in the Now feed. Interactive runs are untouched.
const stopStalledScheduledRunReconciler = registerStalledScheduledRunReconciler(
  {
    db,
  },
);
// CL-2248: fail orphaned in-flight runs FIRST, on the pre-reconcile routable
// snapshot — before reconcileAll re-registers supervisors and makes every run
// look routable. Then re-establish supervisors so NEW runs work.
void workflowReconciler
  .failOrphanedRuns()
  .catch((err) => {
    log.warn("initial failOrphanedRuns failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  })
  .then(() => workflowReconciler.reconcileAll())
  // CL-2582: reclaim per-run deployments whose terminal teardown didn't fire
  // (hub crashed between the terminal save and teardown). After reconcileAll so
  // a re-established live run is never mistaken for an orphan.
  .then(() => workflowReconciler.reclaimOrphanedDeployments())
  .catch((err) => {
    log.warn("initial workflow reconcile failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });

// Automation scheduler: fire durable scheduled_trigger rows on a
// daily UTC-hour cadence by calling the run-start service directly (no HTTP
// self-call). Single-replica assumption — like the disconnect reconciler, N
// replicas would fire N runs/schedule/day; a DB-backed fire-lock is the
// multi-replica follow-up.
const listMyraTargets = async () => {
  const rows = await db.query.memberAgentInstance.findMany({
    where: and(
      eq(schema.memberAgentInstance.tenantId, rootTenantId),
      eq(schema.memberAgentInstance.templateKey, "myra"),
    ),
  });
  return rows.map((row) => ({ memberPrincipalId: row.memberPrincipalId }));
};

// Gate shapes per kind (CL-3509), loaded once from the committed embedded
// catalog — static for the process lifetime. The scheduler auto-delivers a
// stored intake only for kinds whose entry gate is `intake`.
const schedulerGateInfos = await loadWorkflowGateInfos();

const scheduler = createScheduler({
  isTenantEnabled: (tenantId) =>
    isFeatureEnabledForTenantCached(
      db,
      tenantId,
      "scheduler",
      config.scheduler.enabled,
    ),
  listSchedules: () => listEnabledSchedules(db, rootTenantId),
  markFired: (id, dayUtc) => markScheduleFired(db, id, dayUtc),
  recordRunStarted: (args) => recordScheduleRunStarted(db, args),
  startWorkflowRun: async (fire) => {
    // Re-read the member's brief-source preferences at the moment the
    // schedule actually fires, rather than trusting whatever `enabledSources`
    // (if any) was baked into the schedule row when it was created — a source
    // toggle in Settings must take effect on the very next brief, not the next
    // time the schedule row itself is edited.
    const [prefs, identity] = await Promise.all([
      readMemberPreferences(db, fire.tenantId, fire.creatorPrincipalId),
      resolveUserIdentity(fire.creatorPrincipalId),
    ]);
    const triggerPayload = enrichHeartbeatTriggerPayload(
      fire.triggerPayload,
      fire.kind,
      config.scheduler.heartbeatKind,
      resolveEnabledBriefSources(prefs),
      fire.nowMs,
      fire.lastFiredDayUtc,
      fire.hourUtc,
      "scheduled",
      identity,
    );
    const result = await runStarter.startRun({
      kind: fire.kind,
      tenantId: fire.tenantId,
      input: triggerPayload,
      creatorPrincipalId: fire.creatorPrincipalId,
      source: "scheduler",
    });
    if (!result.ok) {
      throw new Error(`run-start ${result.reason}: ${result.message}`);
    }
    // Auto-deliver the stored intake so the scheduled run passes its first gate
    // without a human (CL-3509). Only for kinds whose entry gate is `intake`; the
    // intake is the stored trigger payload minus server-owned identity keys.
    if (schedulerGateInfos.get(fire.kind)?.requiresIntake === true) {
      const intake = extractStoredIntake(fire.triggerPayload);
      await queueScheduledIntakeSignal(db, {
        runId: result.runId,
        kind: fire.kind,
        intake,
      }).catch((err) => {
        log.error("scheduler: intake auto-delivery failed", {
          scheduleKind: fire.kind,
          runId: result.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }
    return {
      deploymentId: result.deploymentId,
      accepted: true,
      runId: result.runId,
    };
  },
});
scheduler.start();

// Live per-item inbox intake (CL-3511): poll each Myra member's enabled inbox
// sources and land new external items as mailbox rows, flowing through the
// same triage pipeline as inbound mail. Gated on the `scheduler` feature grant
// (same env override OR owner grant) — the other durable-poll automation.
// Single-replica assumption, like the scheduler above.
const listInboxMembers = async () => {
  const rows = await db
    .select({
      memberPrincipalId: schema.memberAgentInstance.memberPrincipalId,
      refId: intxSchema.principal.refId,
      email: intxSchema.user.email,
    })
    .from(schema.memberAgentInstance)
    .innerJoin(
      intxSchema.principal,
      eq(intxSchema.principal.id, schema.memberAgentInstance.memberPrincipalId),
    )
    .innerJoin(
      intxSchema.user,
      eq(intxSchema.user.id, intxSchema.principal.refId),
    )
    .where(
      and(
        eq(schema.memberAgentInstance.tenantId, rootTenantId),
        eq(schema.memberAgentInstance.templateKey, "myra"),
      ),
    );
  return rows.map((row) => ({
    tenantId: rootTenantId,
    memberPrincipalId: row.memberPrincipalId,
    inboxAddress: deriveUserMailAddress({
      userRefId: row.refId,
      domain: config.rootTenant.domain,
    }),
    tenantDomain: config.rootTenant.domain,
    email: row.email ?? null,
  }));
};

const granolaFanout = createGranolaCallFanout({
  db,
  grantStore,
  rootTenantId,
  rootTenantDomain: config.rootTenant.domain,
  mailboxEventBus,
});
const granolaPipeline = createGranolaCallPipeline({
  db,
  rootTenantDomain: config.rootTenant.domain,
  resolveInferenceSource: async (tenantId) => {
    const def = await resolveMyraDefinition(db, tenantId);
    if (!def) return null;
    const res = await resolveInstanceSourcesFromDefinition(
      db,
      tenantId,
      def,
      null,
    );
    return res.ok ? (res.sources[0] ?? null) : null;
  },
  fanout: granolaFanout,
});
const granolaCallJobQueue = createGranolaCallJobQueue(db);
const granolaCallJobRunner = createGranolaCallJobRunner({
  db,
  queue: granolaCallJobQueue,
  pipeline: granolaPipeline,
});
granolaCallJobRunner.start();

const inboxIntake = createInboxIntake({
  db,
  grantStore,
  registry: [
    ...INBOX_SOURCE_REGISTRY,
    createGranolaWorkspaceInboxSource({ queue: granolaCallJobQueue }),
  ],
  listMembers: listInboxMembers,
  mailboxEventBus,
  mailboxTriage,
  tickIntervalMs: config.inboxIntake.tickIntervalMs,
  isTenantEnabled: (tenantId) =>
    isFeatureEnabledForTenantCached(
      db,
      tenantId,
      "scheduler",
      config.scheduler.enabled,
    ),
  isWorkspaceSourceEnabled: (tenantId, sourceKey) =>
    isWorkspaceInboxSourceEnabledForTenant(db, tenantId, sourceKey),
  isMemberSourceEnabled: (tenantId, sourceKey) =>
    isWorkspaceInboxSourceEnabledForTenant(db, tenantId, sourceKey),
});
inboxIntake.start();

// Native-task pending-ref reconciler. Gated by the `tasks-reconciler` feature
// grant on the root tenant (env override OR owner grant, default OFF); the
// reconciler is not tenant-partitioned (`reconcileOnce` scans all pending
// refs), so the grant check is scoped to the deployment's root tenant.
const taskReconciler = createTaskReconcilerService({
  isEnabled: () =>
    isFeatureEnabledForTenantCached(
      db,
      rootTenantId,
      "tasks-reconciler",
      config.tasksReconciler.enabled,
    ),
  db,
  pushService: taskPushService,
});
taskReconciler.start();

// Idempotent boot seed so the morning brief works out of the box: one heartbeat
// schedule per Myra member. Gated by the same enable flag; detached so a slow
// seed never blocks startup.
void seedHeartbeatSchedules({
  enabled: config.scheduler.enabled,
  kind: config.scheduler.heartbeatKind,
  hourUtc: config.scheduler.heartbeatHourUtc,
  listMyraTargets,
  resolveUserIdentity,
  ensureSchedule: (args) =>
    ensureOwnerSchedule(db, {
      tenantId: rootTenantId,
      ownerPrincipalId: args.ownerPrincipalId,
      kind: args.kind,
      hourUtc: args.hourUtc,
      payload: args.payload,
    }),
}).catch((err) => {
  log.error("heartbeat schedule seed failed", {
    error: err instanceof Error ? err : new Error(String(err)),
  });
});

// CL-2670: backfill analytics facts for any terminal run missing a fact — a run
// whose live projection threw (WRN, now ERROR) or that reached terminal while the
// projector was absent. Idempotent (skips runs that already have a fact) and
// detached so it never blocks startup.
void backfillMissingWorkflowFacts({
  db,
  repoStore,
  deploymentDomain: config.rootTenant.domain,
})
  .then((result) => {
    if (result.projected > 0) {
      log.info("workflow analytics fact backfill projected {projected} runs", {
        projected: result.projected,
        skipped: result.skipped,
      });
    }
  })
  .catch((err) => {
    log.error("workflow analytics fact backfill failed", {
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
  deploymentDomain: config.rootTenant.domain,
  rootTenantId,
};

// CL-3093: sync embedded tool tarballs into the root package-registry before
// workflow autopublish so sidecars resolve fresh pins on reconnect. Detached;
// fail-safe per tarball; does not block HTTP listen.
void publishEmbeddedToolPackages({
  db,
  repoStore: repoStore.repoStore,
  assetService,
  rootTenantId,
  enabled: config.toolRegistryAutopublishOnBoot,
  registryName: config.toolRegistryName,
  buildSha: config.buildSha,
})
  .catch((err) => {
    log.error("tool registry autopublish-on-boot failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (config.toolRegistryAutopublishOnBoot) {
      void flushSentry().finally(() => process.exit(1));
    }
  })
  .then(() =>
    // CL-2593: auto-publish build-serialized workflow defs after tool sync.
    publishEmbeddedWorkflowDefs({
      coreDeps: workflowDeployCoreDeps,
      repoStore,
      enabled: config.workflowAutopublishOnBoot,
      buildSha: config.buildSha,
      autopublishMap: config.workflowAutopublishMap,
    })
      // Reconcile the whole existing catalog to deny-by-default once the boot
      // publish has settled.
      .then(() => backfillDenyForExistingWorkflowKinds(db))
      .catch((err) => {
        log.error("workflow autopublish-on-boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
  );

v1.post(
  "/workflows/deploy",
  createWorkflowDeployGrantGuard({ db, grantStore, rootTenantId }),
  deployWorkflowHandler(workflowDeployCoreDeps),
);

// DELETE/undeploy a workflow deployment. Same operator grant guard as the
// session-authorized deploy route; tenant-scoped lookup keeps a caller from
// deleting another tenant's deployment.
v1.delete(
  "/workflows/:deploymentId",
  describeRoute({
    tags: ["Workflows"],
    summary: "Delete (undeploy) a workflow deployment",
    description:
      "Operator-gated. Soft-deletes the deployment (drops it from list/stream/start), undeploys the sidecar supervisor, and stops its step instances. Optional `?tenantId=` selects a workbench the user belongs to.",
    parameters: [
      {
        name: "deploymentId",
        in: "path",
        required: true,
        description: "Deployment id (ses_…) of the workflow to delete.",
        schema: { type: "string" },
      },
      {
        name: "tenantId",
        in: "query",
        required: false,
        description:
          "Target workbench tenant id. Omit for the active workbench.",
        schema: { type: "string" },
      },
    ],
    responses: {
      204: { description: "Deployment deleted and undeployed" },
      403: {
        description:
          "User context not found or forbidden for the requested tenant",
      },
      404: { description: "Workflow deployment not found" },
    },
  }),
  createWorkflowDeployGrantGuard({ db, grantStore, rootTenantId }),
  deleteWorkflowHandler(workflowDeployCoreDeps),
);

// Abort workflow RUNS (CL-2262), operator-gated by the same session grant guard
// as the deploy/delete-deployment routes — an operator can abort ANY run, so
// there is no per-user ownership check (unlike the user-facing /workflow-exec
// read/resume routes). Marks the run record terminal; CL-2248's boot-reconciler
// reaps the sidecar dir on next restart. `abort-active` is registered before the
// `:runId` route so the literal segment is not captured as a runId.
v1.post(
  "/workflow-exec/records/abort-active",
  abortActiveRunsRouteDescription,
  createWorkflowDeployGrantGuard({ db, grantStore, rootTenantId }),
  abortActiveRunsHandler({ db }),
);
v1.delete(
  "/workflow-exec/records/:runId",
  abortRunRouteDescription,
  createWorkflowDeployGrantGuard({ db, grantStore, rootTenantId }),
  abortRunHandler({ db }),
);

app.route("/api/v1", v1);

// ─── Internal routes (sidecar token auth) ──────────────────────────

app.route(
  "/api/internal",
  createInternalApprovalsRouter(db, config.sidecarToken, approvalsEventBus),
);
app.route(
  "/api/internal",
  createHubToolsRouter(db, config.sidecarToken, {
    sessionService,
    eventCollectors,
    sidecarRouter,
    analytics: analyticsSubscriber,
    repoStore: repoStore.repoStore,
    buildToolDefinitions,
    // Workflow-run tools (CL-2678) share the /workflow-exec routes' pre-bound
    // start/resume wiring.
    cryptoProvider,
    deploymentDomain: config.rootTenant.domain,
    provisionRunDeployment,
    ensureDeploymentRoutable,
  }),
);
app.route(
  "/api/internal",
  createToolCredentialsRouter(db, config.sidecarToken),
);
app.route(
  "/api/internal",
  createToolManifestRouter(db, config.sidecarToken, assetService),
);
app.route(
  "/api/internal",
  createInternalDeploymentsRouter(
    db,
    config.sidecarToken,
    repoStore,
    config.rootTenant.domain,
  ),
);
app.route(
  "/api/internal",
  createWorkflowDeployRouter({
    ...workflowDeployCoreDeps,
    serviceToken: config.sidecarToken,
  }),
);

// The web SPA is deployed as its own static Railway service (apps/web),
// not served from here. The hub is API-only.

// ─── Health & version ───────────────────────────────────────────────

app.route("/", createSystemRouter(config.buildSha));

const port = Number(config.port);

if (import.meta.main) {
  log.info("API starting", { port });
}

// ─── Graceful shutdown ──────────────────────────────────────────────
//
// Railway sends SIGTERM then SIGKILL after ~10 s. Close sidecar WebSockets
// first: awaiting server.stop() while a sidecar link is still open never
// reaches closeAll(), so the sidecar sits on a zombie socket until pong
// timeout. Then drain in-flight HTTP briefly and exit.

const SHUTDOWN_DRAIN_MS = 8_000;

// eslint-disable-next-line prefer-const -- assigned after a closure captures it below
let server: ReturnType<typeof Bun.serve> | undefined;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    try {
      log.info("Received {signal}, draining", { signal });
      scheduler.stop();
      taskReconciler.stop();
      stopWedgeSweepReconciler();
      stopAwaitingSupervisorPrewarm();
      stopStalledScheduledRunReconciler();
      log.info("Closing sidecar connections", {
        count: sidecarConnections.size(),
      });
      sidecarConnections.closeAll();
      await Promise.race([
        server?.stop() ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        }),
      ]);
      log.info("Server stopped, exiting");
      process.exit(0);
    } catch (err) {
      log.fatal("Shutdown error", { error: err });
      process.exit(1);
    }
  });
}

process.on("uncaughtException", (err) => {
  // log.fatal routes to the Sentry sink; flush before exiting so the event is
  // not dropped on process death.
  log.fatal("Uncaught exception", { error: err });
  void flushSentry().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal("Unhandled rejection", { error: err });
  // The process keeps running here, but flush so the captured event is not
  // left buffered indefinitely if the process later dies.
  void flushSentry();
});

// Centralized handler for errors thrown out of any route. Logging at error
// level routes to the Sentry sink, so no request error fails silent.
app.onError((err, c) => {
  log.error("Unhandled request error", {
    error: err,
    method: c.req.method,
    path: c.req.path,
  });
  // Flag so serverErrorReporter does not log this 500 a second time.
  c.set(SERVER_ERROR_LOGGED, true);
  return c.json({ error: "Internal Server Error" }, 500);
});

export { app };

server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
