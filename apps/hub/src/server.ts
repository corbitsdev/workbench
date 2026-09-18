import {
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
  resolveFrameSenderKey,
  resolveSenderKey,
} from "@intx/db";
import {
  asset as assetTable,
  principal as principalTable,
  tenant as tenantTable,
} from "@intx/db/schema";
import { and, eq } from "drizzle-orm";
import { createEnvKeyCredentialCipher, sha256 } from "@intx/crypto";
import { hexDecode, hexEncode, type SidecarCapabilityRule } from "@intx/types";
import {
  createApp,
  createAuth,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import {
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarPluginRegistry,
  createSidecarRouter,
  createSidecarCredentialResolver,
  createWorkflowAllocationService,
  createWorkflowDispatchService,
  createReconciliationScheduler,
  DEFAULT_SIDECAR_ALLOCATION_CONCURRENCY,
  pushCredentialReconcile,
  pushSourceUpdates,
  WORKSPACE_BUILTINS_REGISTRY,
  type SidecarLookups,
  type SidecarProvisioner,
  type SidecarProvisionerChooser,
  type WsHandle,
} from "@intx/hub-sessions";
import { generateKeyPair } from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import { MAX_SIDECAR_FRAME_BYTES } from "@intx/types/sidecar";
import { upgradeWebSocket, websocket } from "hono/bun";
import { setup, getLogger } from "@intx/log";
import { Hono } from "hono";

// Everything above this line is upstream Interchange's server.ts, verbatim;
// see AGENTS.md's "plain Interchange tenant" ruling.
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  mountMailbox,
} from "@corbits/mailbox";
import {
  createMemory,
  loadMemoryConfig,
  mountWorkflowMemory,
  type WorkflowMemoryEnv,
} from "@corbits/memory";
import {
  createOAuthTokenRefresher,
  mountOAuthLogin,
  type OAuthLoginProviders,
} from "@corbits/oauth-core/hub";
import {
  CODEX_PROVIDER,
  codexOAuthConfig,
  exchangeCodexCode,
  refreshCodexTokens,
} from "@corbits/codex-provider";
import {
  XAI_PROVIDER,
  xaiOAuthConfig,
  exchangeXaiCode,
  refreshXaiTokens,
} from "@corbits/xai-provider";
import { createAgentTokenVerifier, mountAgentTokens } from "@corbits/agent-token";
import { createCronTicker, createRunTriggerCronDeliver, mountCron } from "@corbits/cron";
import {
  createHubMailboxAuthorizeSender,
  createHubPersistMailWithSessionEnsure,
} from "./mailbox-persist";
import { captureMailboxRequest, createMailboxDeliver } from "./mailbox-send";
import { reportError } from "@corbits/error-sink";
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  installWebhooks,
  type HookMailRouter,
} from "@corbits/webhooks";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
  type ProcessProvisionerRole,
} from "./provisioners/process";
import {
  InlineContentStore,
  mountArtifacts,
  mountWorkflowArtifacts,
  type WorkflowArtifactEnv,
} from "@corbits/artifacts";
import { artifactMatchesLibraryKindSegment, LIBRARY_KIND_SEGMENTS } from "./library-kind-segments";
import type { DB } from "@intx/db";
import { sidecar, workflowRun } from "@intx/db/schema";
import path from "node:path";
import { migrateHub } from "./migrate";

// The same condition registry `mountHubRoutes` builds by default when no
// registry is supplied -- kept as one local constant so every Corbits
// route factory below shares the identical registry rather than each
// re-deriving stock's own default.
const grantConditionRegistry: ConditionRegistry = {
  time_window: timeWindowEvaluator,
};

// The one concrete `WorkflowRunAuthenticator` every workflow-run-authenticated
// Corbits surface below takes structurally (`@corbits/artifacts`'
// `mountWorkflowArtifacts`): a sidecar bearer token + run address resolve to
// the tenant/principal/run it names.
function createWorkflowRunAuthenticator(deps: { db: DB["db"] }) {
  return {
    async resolve(token: string, runAddress: string) {
      if (token === "" || runAddress === "") return null;
      const tokenHash = await sha256(token);
      const sidecarRow = await deps.db.query.sidecar.findFirst({
        where: eq(sidecar.tokenHashSha256, tokenHash),
      });
      if (sidecarRow === undefined) return null;
      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;
      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}

function buildProcessSidecarProvisioner(
  hubDataDir: string,
  hubWebSocketUrl: string,
  role: ProcessProvisionerRole,
): SidecarProvisioner {
  return createProcessSidecarProvisioner({
    role,
    config: readProcessProvisionerConfig({
      env: process.env,
      dataDir: path.resolve(
        hubDataDir,
        role === "probe" ? "process-provisioner-probe" : "process-provisioner",
      ),
      hubWebSocketUrl,
    }),
  });
}

export type CreateHubServerOpts = {
  /** Provisioners eligible to host frozen workflow deployments. */
  readonly sidecarProvisioners?: readonly SidecarProvisioner[];
  /** Selects among matching deployment provisioners. Defaults to the first. */
  readonly sidecarProvisionerChooser?: SidecarProvisionerChooser;
  /** Provisioners eligible to evaluate workflow source code. */
  readonly probeSidecarProvisioners?: readonly SidecarProvisioner[];
  /** Selects among matching probe provisioners. Defaults to the first. */
  readonly probeSidecarProvisionerChooser?: SidecarProvisionerChooser;
  readonly probeSidecarCapabilityRules?: readonly SidecarCapabilityRule[];
  /** Maximum simultaneous allocation reconciliations. Defaults to eight. */
  readonly sidecarAllocationConcurrency?: number;
  /** Deadline for provider calls, allocation claims, lease validation, and connection waits. Defaults to 120 seconds. */
  readonly sidecarOperationTimeoutMs?: number;
};

export async function createHubServer({
  sidecarProvisioners,
  sidecarProvisionerChooser,
  probeSidecarProvisioners,
  probeSidecarProvisionerChooser,
  probeSidecarCapabilityRules = [],
  sidecarAllocationConcurrency = DEFAULT_SIDECAR_ALLOCATION_CONCURRENCY,
  sidecarOperationTimeoutMs,
}: CreateHubServerOpts = {}) {
  await setup();

  const log = getLogger(["hub"]);
  const port = Number(process.env["PORT"] ?? 3000);

  // PG_SCHEMA pins the hub to a specific postgres schema. The
  // integration-test harness sets this so each spawned hub gets a
  // dedicated, droppable schema. Production deployments leave it
  // unset and run against postgres' default search_path.
  const pgSchema = process.env["PG_SCHEMA"];
  const dbConfig = {
    host: process.env["DB_HOST"] ?? "localhost",
    port: Number(process.env["DB_PORT"] ?? 5432),
    user: process.env["DB_USER"] ?? "postgres",
    password: process.env["DB_PASSWORD"] ?? "postgres",
    database: process.env["DB_NAME"] ?? "interchange",
    ...(pgSchema !== undefined && { schema: pgSchema }),
  };
  const { db } = createDB(dbConfig);

  // Platform schema plus every mounted Corbits package's own migration,
  // applied once at boot before anything below reads or writes the
  // database.
  await migrateHub(dbConfig, db);

  const auth = createAuth(db);

  const hubDataDir = process.env["HUB_DATA_DIR"];
  if (!hubDataDir) {
    throw new Error("HUB_DATA_DIR environment variable is required");
  }

  // Credential secrets are encrypted at rest under this operator-provided key.
  const credentialEncryptionKeyHex = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (credentialEncryptionKeyHex === undefined || credentialEncryptionKeyHex.trim() === "") {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY environment variable is required");
  }
  const credentialCipher = createEnvKeyCredentialCipher(hexDecode(credentialEncryptionKeyHex));

  // Per-principal signing keys are sealed at rest under their own operator key.
  const principalKeyEncryptionKeyHex = process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"];
  if (principalKeyEncryptionKeyHex === undefined || principalKeyEncryptionKeyHex.trim() === "") {
    throw new Error("PRINCIPAL_KEY_ENCRYPTION_KEY environment variable is required");
  }
  const principalKeyStore = createPrincipalKeyStore({
    db,
    cipher: createEnvKeyCredentialCipher(hexDecode(principalKeyEncryptionKeyHex)),
  });

  const DEFAULT_HUB_MAX_TARBALL_BYTES = 10 * 1024 * 1024;
  const hubMaxTarballBytesRaw = process.env["HUB_MAX_TARBALL_BYTES"];
  const hubMaxTarballBytes =
    hubMaxTarballBytesRaw === undefined || hubMaxTarballBytesRaw.trim() === ""
      ? DEFAULT_HUB_MAX_TARBALL_BYTES
      : Number(hubMaxTarballBytesRaw);
  if (!Number.isFinite(hubMaxTarballBytes) || hubMaxTarballBytes <= 0) {
    throw new Error(
      `HUB_MAX_TARBALL_BYTES must be a positive number; got ${JSON.stringify(hubMaxTarballBytesRaw)}`,
    );
  }

  const hubSigningKey = await generateKeyPair();
  log.info("Generated hub deploy signing key");

  const agentRepoStore = createAgentRepoStore({
    dataDir: hubDataDir,
    signingKey: hubSigningKey,
  });

  const httpRegistries = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);

  const assetService = createAssetService({
    db,
    repoStore: agentRepoStore.repoStore,
    reservedPackageRegistryNames: new Set(httpRegistries.keys()),
  });

  const grantStore = createGrantStore(db);

  const lookups: SidecarLookups = {
    ...createHubSessionLookups({ db, agentRepoStore }),
    materializeMailTriggeredRunGrants: createMailTriggeredRunGrantsMaterializer({
      db,
      principalKeyStore,
      grantStore,
    }),
    resolveSenderKey: (address) => resolveFrameSenderKey(db, principalKeyStore, address),
    resolveSenderKeyStrict: async (address) =>
      (await resolveSenderKey(db, principalKeyStore, address))?.publicKey ?? null,
  };

  const sidecarCredentials = createSidecarCredentialResolver({ db });

  const sidecarRouter = createSidecarRouter({
    hubPublicKey: hexEncode(hubSigningKey.publicKey),
    authenticateSidecar: async ({ token }) => sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    lookups,
  });

  lookups.resyncCredentials = (agentAddress) => {
    void pushCredentialReconcile(db, sidecarRouter, agentAddress, credentialCipher);
  };

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
        },
      });
    },
  });

  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
  });

  const sessionService = createSessionService({
    sidecarRouter,
    sidecarAllocationRouter: sidecarRouter,
    agentRepoStore,
    assetService,
    db,
    toolPackageRegistries: {
      httpRegistries,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@intx", registry: WORKSPACE_BUILTINS_REGISTRY }],
    },
  });

  const hubSidecarWebSocketUrl =
    process.env["HUB_SIDECAR_WEBSOCKET_URL"] ?? `ws://127.0.0.1:${String(port)}/api/sidecars/ws`;

  const deploymentProvisioners = sidecarProvisioners ?? [
    buildProcessSidecarProvisioner(hubDataDir, hubSidecarWebSocketUrl, "deployment"),
  ];
  const probeProvisioners = probeSidecarProvisioners ?? [
    buildProcessSidecarProvisioner(hubDataDir, hubSidecarWebSocketUrl, "probe"),
  ];

  const sidecarPlugins = createSidecarPluginRegistry({
    provisioners: deploymentProvisioners,
    ...(sidecarProvisionerChooser !== undefined ? { chooser: sidecarProvisionerChooser } : {}),
  });
  const probeSidecarPlugins = createSidecarPluginRegistry({
    provisioners: probeProvisioners,
    ...(probeSidecarProvisionerChooser !== undefined
      ? { chooser: probeSidecarProvisionerChooser }
      : {}),
  });
  const workflowAllocationService = createWorkflowAllocationService({
    db,
    deploymentPlugins: sidecarPlugins,
    probePlugins: probeSidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    probeCapabilityRules: probeSidecarCapabilityRules,
    allocationRouter: sidecarRouter,
    hubWebSocketUrl: hubSidecarWebSocketUrl,
    ...(sidecarOperationTimeoutMs !== undefined
      ? { operationTimeoutMs: sidecarOperationTimeoutMs }
      : {}),
  });
  const sidecarAllocationStore = createSidecarAllocationStore(db);
  const workflowDispatchService = createWorkflowDispatchService({
    dispatchStore: createWorkflowRunDispatchStore(db),
    allocationStore: sidecarAllocationStore,
    router: sidecarRouter,
    resolveAnchorAddress: async (anchorRunId) => {
      const row = await db.query.workflowRun.findFirst({
        where: (run, { eq: equals }) => equals(run.id, anchorRunId),
        columns: { address: true },
      });
      return row?.address ?? null;
    },
  });
  const sidecarAllocationReconciler = createSidecarAllocationReconciler({
    allocationStore: sidecarAllocationStore,
    plugins: sidecarPlugins,
    router: sidecarRouter,
    hubWebSocketUrl: hubSidecarWebSocketUrl,
    ...(sidecarOperationTimeoutMs !== undefined
      ? { operationTimeoutMs: sidecarOperationTimeoutMs }
      : {}),
    onReady: async (allocation, reconciliation) => {
      await workflowAllocationService.deployReadyAllocation(allocation, reconciliation);
      reconciliation.signal.throwIfAborted();
      await workflowDispatchService.requeueForReadyAllocation(allocation.anchorRunId);
    },
  });

  await workflowAllocationService.initialize?.();
  await sidecarAllocationReconciler.initialize();
  sidecarRouter.events.on("sidecar.disconnect", ({ allocated }) => {
    if (allocated === undefined) return;
    return sidecarAllocationReconciler.handleDisconnect(allocated);
  });
  sidecarRouter.events.on("sidecar.allocated.connected", (allocated) =>
    sidecarAllocationReconciler.handleConnected(allocated),
  );
  sidecarRouter.events.on("mail.inbound.acknowledged", ({ messageId, allocated }) => {
    if (allocated === undefined) return;
    return workflowDispatchService.acknowledge({ ...allocated, messageId });
  });

  const allocationScheduler = createReconciliationScheduler({
    name: "Sidecar allocation",
    concurrency: sidecarAllocationConcurrency,
    reconcileNext: () => sidecarAllocationReconciler.reconcileNext(),
  });
  const probeCleanupScheduler = createReconciliationScheduler({
    name: "Workflow probe cleanup",
    concurrency: 1,
    intervalMs: 30_000,
    reconcileNext: async () => {
      await workflowAllocationService.reconcileReleasingProbes?.();
      return false;
    },
  });
  const dispatchScheduler = createReconciliationScheduler({
    name: "Workflow dispatch",
    concurrency: 1,
    reconcileNext: async () => {
      workflowDispatchService.wake();
      return false;
    },
  });
  const connectionRepairScheduler = createReconciliationScheduler({
    name: "Sidecar connection repair",
    concurrency: 1,
    intervalMs: 30_000,
    reconcileNext: async () => {
      await sidecarAllocationReconciler.repairUnscheduledConnections();
      return false;
    },
  });

  allocationScheduler.start();
  probeCleanupScheduler.start();
  dispatchScheduler.start();
  connectionRepairScheduler.start();

  const app = createApp({
    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: (c) => auth.handler(c.req.raw),
    db,
    sidecarRouter,
    sessionService,
    workflowAllocationService,
    workflowDispatchService,
    eventCollectors,
    credentialCipher,
    principalKeyStore,
    assetService,
    repoStore: agentRepoStore.repoStore,
    maxTarballBytes: hubMaxTarballBytes,
    workflowRunAuthenticator: createWorkflowRunAuthenticator({ db }),
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
          if (typeof evt.data === "string") {
            sidecarRouter.handleMessage(handle, evt.data);
          }
        },
        onClose(_evt, _ws) {
          sidecarRouter.handleClose(handle);
        },
      };
    }),
  });

  // Corbits mount block -- everything Workbench adds to the stock hub.
  // See AGENTS.md: any other hub mount is cutover debt, never a pattern to extend.
  const TENANT_PREFIX = "/api/tenants/:tenantId";
  const corbitsDatabaseUrl = `postgres://${encodeURIComponent(process.env["DB_USER"] ?? "postgres")}:${encodeURIComponent(process.env["DB_PASSWORD"] ?? "postgres")}@${process.env["DB_HOST"] ?? "localhost"}:${String(Number(process.env["DB_PORT"] ?? 5432))}/${process.env["DB_NAME"] ?? "interchange"}`;
  const { db: mailboxDb } = createMailboxDb(corbitsDatabaseUrl);
  const mailboxBus = createInMemoryMailboxEventBus();
  const eventCollectorsRef: { current?: typeof eventCollectors } = { current: eventCollectors };
  const mailboxLookups = {
    ...lookups,
    persistMail: createMailboxPersist(mailboxDb, {
      upstream: createHubPersistMailWithSessionEnsure(
        db,
        eventCollectorsRef,
        createHubSessionLookups({ db, agentRepoStore }).persistMail,
      ),
      authorizeSender: createHubMailboxAuthorizeSender(db),
      bus: mailboxBus,
    }),
  };
  // The sidecar router captured `lookups` before this wrapper existed; an
  // agent's outbound mail must also land in principal inboxes.
  lookups.persistMail = mailboxLookups.persistMail;

  const artifactContentStore = InlineContentStore;

  {
    const artifactsApi = new Hono<TenantEnv>();
    mountArtifacts(artifactsApi, {
      db,
      contentStore: artifactContentStore,
      requireGrant: createRequireGrant({ grantStore, conditionRegistry: grantConditionRegistry }),
      countSegments: Object.fromEntries(
        LIBRARY_KIND_SEGMENTS.map((segment) => [
          segment,
          (row: { kind: string; title: string }) => artifactMatchesLibraryKindSegment(row, segment),
        ]),
      ),
    });
    app.route(TENANT_PREFIX, artifactsApi);
  }
  {
    // Minting an agent token is minting a credential, so it is gated by the
    // same stock grant the credential routes are, not by tenant membership.
    const agentTokensApp = new Hono<TenantEnv>();
    const requireAgentTokenGrant = createRequireGrant({
      grantStore,
      conditionRegistry: grantConditionRegistry,
    });
    mountAgentTokens(agentTokensApp, {
      db,
      requireGrant: requireAgentTokenGrant("credential:*", "create"),
      resolveTenantId: (ctx) => (ctx as { get(key: "tenant"): { id: string } }).get("tenant").id,
      // A token is scoped to the agent's `workflow` source asset: the
      // tenant-owned thing that already exists when the workbench mints the
      // token, before the deploy that would create a run.
      resolveDefinition: async (tenantId, definitionId) => {
        const row = await db.query.asset.findFirst({
          where: and(
            eq(assetTable.id, definitionId),
            eq(assetTable.tenantId, tenantId),
            eq(assetTable.kind, "workflow"),
          ),
        });
        return row !== undefined;
      },
    });
    app.route(TENANT_PREFIX, agentTokensApp);
  }
  // A deployed agent has no sidecar token; it presents the bearer this hub
  // minted for its definition and is scoped to the run it names. One
  // verifier and one run lookup serve every run-scoped Corbits mount.
  const verifyAgentToken = createAgentTokenVerifier({ db });
  const resolveAgentRun = async (runAddress: string) => {
    if (runAddress === "") return null;
    const run = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.address, runAddress),
    });
    if (run === undefined || run.principalId === null) return null;
    return { tenantId: run.tenantId, principalId: run.principalId, runId: run.id };
  };

  {
    const workflowArtifactsApi = new Hono<WorkflowArtifactEnv>();
    const workflowRunAuthenticator = createWorkflowRunAuthenticator({ db });
    mountWorkflowArtifacts(workflowArtifactsApi, {
      db,
      contentStore: artifactContentStore,
      resolveRunScope: (token, runAddress) => workflowRunAuthenticator.resolve(token, runAddress),
      agentToken: { verify: (ctx) => verifyAgentToken(ctx), resolveRun: resolveAgentRun },
    });
    app.route("/api/workflow-artifacts", workflowArtifactsApi);
  }
  {
    const mailboxApp = new Hono<TenantEnv>();
    // Registered before the routes: Hono runs handlers in registration order.
    mailboxApp.use("/me/inbox/send", captureMailboxRequest());
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      resolvePrincipal: (ctx) => {
        const c = ctx as { get(key: "tenant" | "principal"): { id: string } };
        return { tenantId: c.get("tenant").id, principalId: c.get("principal").id };
      },
      // The address stock itself stamps on a person's outbound mail, so a
      // Sent copy and the agent's reply share one identity.
      senderAddressFor: async (principal) => {
        const [tenantRow] = await db
          .select({ domain: tenantTable.domain })
          .from(tenantTable)
          .where(eq(tenantTable.id, principal.tenantId))
          .limit(1);
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${principal.tenantId}" to address a mailbox sender from`);
        }
        const [principalRow] = await db
          .select({ refId: principalTable.refId })
          .from(principalTable)
          .where(eq(principalTable.id, principal.principalId))
          .limit(1);
        if (principalRow === undefined) {
          throw new Error(`no principal "${principal.principalId}" to address a mailbox sender as`);
        }
        return `${principalRow.refId}@${tenantRow.domain}`;
      },
      deliver: createMailboxDeliver({ app, persistMail: mailboxLookups.persistMail }),
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  // The router every system-originated trigger (webhook, cron) goes
  // through. `HookMailRouter` types its payloads as `unknown` at the
  // package boundary; this just narrows them back to `sidecarRouter`'s own
  // types on the way through, with no behavior change.
  const systemTriggerMailRouter: HookMailRouter = {
    routeMail: (address, rawMessage, authenticatedSender, messageId) =>
      sidecarRouter.routeMail(address, rawMessage, authenticatedSender, messageId),
    sendRunGrants: (address, runId, stepGrants, senderIdentities) =>
      sidecarRouter.sendRunGrants(
        address,
        runId,
        stepGrants as Parameters<typeof sidecarRouter.sendRunGrants>[2],
        senderIdentities as Parameters<typeof sidecarRouter.sendRunGrants>[3],
      ),
  };

  let cronTicker: { start(): void; stop(): void } | undefined;
  let oauthTokenRefresher: { start(): void; stop(): void } | undefined;
  {
    const cronApp = new Hono<TenantEnv>();
    mountCron(cronApp, {
      db,
      requireTenantMember: (ctx, tenantId) => {
        const c = ctx as { get(key: "tenant"): { id: string } };
        return c.get("tenant").id === tenantId;
      },
    });
    app.route("/", cronApp);

    cronTicker = createCronTicker({
      db,
      intervalMs: 60_000,
      // A due schedule fires with nobody signed in, so it cannot ride the
      // mailbox persist path, which authorizes its sender against a live
      // routable endpoint. It is a system trigger like an inbound webhook,
      // so it takes the same route: the run is the authenticated sender of
      // its own signed trigger mail, with its grants materialized first.
      deliver: createRunTriggerCronDeliver(
        createRunTriggerDeliverer({
          router: systemTriggerMailRouter,
          materialize: createMailTriggeredRunGrantsMaterializer({
            db,
            principalKeyStore,
            grantStore,
          }),
          tenantDomain: async (tenantId) => {
            const [tenantRow] = await db
              .select({ domain: tenantTable.domain })
              .from(tenantTable)
              .where(eq(tenantTable.id, tenantId))
              .limit(1);
            if (tenantRow === undefined) {
              throw new Error(`no tenant "${tenantId}" to address cron mail from`);
            }
            return tenantRow.domain;
          },
          senderLocalPart: "cron",
          // A durable per-tenant key the recipient can verify against;
          // the sidecar rejects trigger mail from an unknown sender.
          systemSender: createTenantSystemSender({ db, principalKeyStore }),
        }),
      ),
      onDeliveryError: (error, schedule) => {
        reportError(error, {
          operation: "hub.cron.deliver",
          extra: { scheduleId: schedule.id, tenantId: schedule.tenantId },
        });
      },
    });
    cronTicker.start();
  }

  {
    const memoryApp = new Hono<TenantEnv>();
    const memory = createMemory({
      app: memoryApp,
      config: loadMemoryConfig(),
      grantStore,
      conditionRegistry: grantConditionRegistry,
    });
    app.route("/", memoryApp);

    // The same plane, reached by a deployed agent's bearer rather than a
    // browser session, and scoped to the run the bearer names.
    const workflowMemoryApi = new Hono<WorkflowMemoryEnv>();
    mountWorkflowMemory(workflowMemoryApi, {
      memory,
      agentToken: { verify: (ctx) => verifyAgentToken(ctx), resolveRun: resolveAgentRun },
    });
    app.route("/api/workflow-memory", workflowMemoryApi);
  }

  {
    // "Continue with Codex"/"Continue with xAI": the whole loopback PKCE
    // flow runs here, so the verifier and the callback listener never
    // leave this process and the browser only learns a credential id.
    const oauthLoginApi = new Hono<TenantEnv>();
    const requireGrant = createRequireGrant({
      grantStore,
      conditionRegistry: grantConditionRegistry,
    });
    const oauthProviders: OAuthLoginProviders = {
      [CODEX_PROVIDER]: {
        oauthConfig: codexOAuthConfig,
        exchange: (code: string, verifier: string, now: number) =>
          exchangeCodexCode(code, verifier, now),
        // The account id the refresher carries forward lives on the
        // credential, so the prior tokens need only supply the secret.
        refresh: (refreshSecret: string, now: number) =>
          refreshCodexTokens(refreshSecret, now, { access: "", refresh: refreshSecret }),
        // The Codex backend rejects inference without this header value.
        metadata: (tokens) =>
          "accountId" in tokens && typeof tokens.accountId === "string"
            ? { accountId: tokens.accountId }
            : {},
      },
      [XAI_PROVIDER]: {
        oauthConfig: xaiOAuthConfig,
        exchange: (code: string, verifier: string, now: number) =>
          exchangeXaiCode(code, verifier, now),
        refresh: (refreshSecret: string, now: number) => refreshXaiTokens(refreshSecret, now),
      },
    };
    mountOAuthLogin(oauthLoginApi, {
      db,
      cipher: credentialCipher,
      requireGrant: requireGrant("credential:*", "create"),
      providers: oauthProviders,
      onError: (error, { provider }) => {
        reportError(error, { operation: "hub.oauth-login", extra: { provider } });
      },
    });
    app.route(TENANT_PREFIX, oauthLoginApi);

    // Stock Interchange has no serving-time refresh hook, so a subscription
    // token that lapses between inference calls would simply fail the next
    // one; this renews it a little before expiry instead.
    oauthTokenRefresher = createOAuthTokenRefresher({
      db,
      cipher: credentialCipher,
      providers: oauthProviders,
      intervalMs: 60_000,
      onRefreshed: ({ tenantId, credentialId }) => {
        // The same push the stock credentials route fires after a secret
        // rotation, so running sidecars get the new material.
        void pushSourceUpdates(db, sidecarRouter, tenantId, credentialCipher).catch(
          (error: unknown) => {
            reportError(error, {
              operation: "hub.oauth-refresh.push",
              extra: { tenantId, credentialId },
            });
          },
        );
      },
      onError: (error, { provider, credentialId }) => {
        reportError(error, {
          operation: "hub.oauth-refresh",
          extra: { provider: provider ?? "", credentialId: credentialId ?? "" },
        });
      },
    });
    oauthTokenRefresher.start();
  }

  await installWebhooks({
    app,
    db,
    credentialCipher,
    principalKeyStore,
    router: systemTriggerMailRouter,
  });

  // End of Corbits mount block.

  log.info("Starting server on port {port}", { port });

  const sidecarWebsocket: typeof websocket & { maxPayloadLength: number } = {
    ...websocket,
    maxPayloadLength: MAX_SIDECAR_FRAME_BYTES,
  };

  return {
    fetch: app.fetch,
    websocket: sidecarWebsocket,
    port,
    idleTimeout: 0,
  };
}
