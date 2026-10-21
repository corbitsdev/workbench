import path from "node:path";
import { createEnvKeyCredentialCipher, generateKeyPair } from "@intx/crypto";
import {
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
  createWorkflowRunLaunchSpecStore,
  resolveFrameSenderKey,
  resolveSenderKey,
  withExecutableWorkflowRun,
} from "@intx/db";
import { createApp, createAuth, createMailTriggeredRunGrantsMaterializer } from "@intx/hub-api";
import {
  attachSidecarProvisioners,
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createParkedRunClassifier,
  createReconciliationScheduler,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarCredentialResolver,
  createSidecarPluginRegistry,
  createSidecarRouter,
  createWorkflowAllocationService,
  createWorkflowDispatchProjection,
  createWorkflowDispatchService,
  createWorkflowHistoryReceiveTracker,
  createWorkflowLifecycleService,
  createWorkflowRunReader,
  DEFAULT_SIDECAR_ALLOCATION_CONCURRENCY,
  DEFAULT_WORKFLOW_PROJECTION_CONCURRENCY,
  pushCredentialReconcile,
  recoverSenderDeploy,
  WORKSPACE_BUILTINS_REGISTRY,
  type SidecarLookups,
  type SidecarProvisioner,
  type SidecarProvisionerChooser,
  type WsHandle,
} from "@intx/hub-sessions";
import { getLogger, setup } from "@intx/log";
import {
  type AdapterManifest,
  hexDecode,
  hexEncode,
  LifecycleDuration,
  lifecycleDurationMs,
  parseAdapterManifestEnv,
  type ResolvedWorkflowLifecyclePolicy,
  type SidecarCapabilityRule,
} from "@intx/types";
import { MAX_SIDECAR_FRAME_BYTES } from "@intx/types/sidecar";
import { upgradeWebSocket, websocket } from "hono/bun";
import { mountCorbits } from "./corbits-mount";
import { migrateHub } from "./migrate";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
  type ProcessProvisionerRole,
} from "./provisioners/process";

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
  readonly sidecarProvisioners?: readonly SidecarProvisioner[];
  readonly sidecarProvisionerChooser?: SidecarProvisionerChooser;
  readonly probeSidecarProvisioners?: readonly SidecarProvisioner[];
  readonly probeSidecarProvisionerChooser?: SidecarProvisionerChooser;
  readonly probeSidecarCapabilityRules?: readonly SidecarCapabilityRule[];
  readonly sidecarAllocationConcurrency?: number;
  readonly sidecarOperationTimeoutMs?: number;
  readonly sidecarAdapterManifest?: AdapterManifest;
};

export async function createHubServer({
  sidecarProvisioners,
  sidecarProvisionerChooser,
  probeSidecarProvisioners,
  probeSidecarProvisionerChooser,
  probeSidecarCapabilityRules = [],
  sidecarAllocationConcurrency = DEFAULT_SIDECAR_ALLOCATION_CONCURRENCY,
  sidecarOperationTimeoutMs,
  sidecarAdapterManifest,
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
  const { db, close: closeDb } = createDB(dbConfig);
  await migrateHub(dbConfig, db);

  const auth = createAuth(db);

  const hubDataDir = process.env["HUB_DATA_DIR"];
  if (!hubDataDir) {
    throw new Error("HUB_DATA_DIR environment variable is required");
  }

  const credentialEncryptionKeyHex = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (credentialEncryptionKeyHex === undefined || credentialEncryptionKeyHex.trim() === "") {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY environment variable is required");
  }
  const credentialCipher = createEnvKeyCredentialCipher(hexDecode(credentialEncryptionKeyHex));

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

  function readOptionalPositiveIntEnv(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`);
    }
    return value;
  }

  function readLifecycleDurationEnv(name: string, fallback: string): string {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    try {
      return LifecycleDuration.assert(raw.trim());
    } catch (cause) {
      throw new Error(
        `${name} must be a lifecycle duration such as 30m or 7d; got ${JSON.stringify(raw)}`,
        { cause },
      );
    }
  }

  const defaultLifecyclePolicy: ResolvedWorkflowLifecyclePolicy = {
    maxLifetime: readLifecycleDurationEnv("WORKFLOW_DEFAULT_MAX_LIFETIME", "7d"),
    maxDisconnected: readLifecycleDurationEnv("WORKFLOW_DEFAULT_MAX_DISCONNECTED", "15m"),
    capacityRetention: {
      completed: readLifecycleDurationEnv("WORKFLOW_DEFAULT_RETENTION_COMPLETED", "30m"),
      failed: readLifecycleDurationEnv("WORKFLOW_DEFAULT_RETENTION_FAILED", "24h"),
      cancelled: readLifecycleDurationEnv("WORKFLOW_DEFAULT_RETENTION_CANCELLED", "1h"),
    },
  };
  if (lifecycleDurationMs(defaultLifecyclePolicy.maxLifetime) === 0) {
    throw new Error("WORKFLOW_DEFAULT_MAX_LIFETIME must be greater than zero");
  }
  if (lifecycleDurationMs(defaultLifecyclePolicy.maxDisconnected) === 0) {
    throw new Error("WORKFLOW_DEFAULT_MAX_DISCONNECTED must be greater than zero");
  }

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

  const workflowHistoryReceives = createWorkflowHistoryReceiveTracker();
  const baseSessionLookups = createHubSessionLookups({
    db,
    agentRepoStore,
    historyReceives: workflowHistoryReceives,
  });
  const lookups: SidecarLookups = {
    ...baseSessionLookups,
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
  const probeTimeoutMs = readOptionalPositiveIntEnv("HUB_PROBE_TIMEOUT_MS");

  const sidecarRouter = createSidecarRouter({
    hubPublicKey: hexEncode(hubSigningKey.publicKey),
    authenticateSidecar: async ({ token }) => sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    withExecutableWorkflowRun: (target, send, signal) =>
      withExecutableWorkflowRun(db, target, send, signal),
    resolveSidecarBindings: sidecarCredentials.resolveBindings,
    lookups,
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
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
  const adapterManifest =
    sidecarAdapterManifest ?? parseAdapterManifestEnv(process.env["SIDECAR_ADAPTER_MANIFEST"]);
  const workflowAllocationService = createWorkflowAllocationService({
    db,
    deploymentPlugins: sidecarPlugins,
    probePlugins: probeSidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    probeCapabilityRules: probeSidecarCapabilityRules,
    allocationRouter: sidecarRouter,
    hubWebSocketUrl: hubSidecarWebSocketUrl,
    defaultLifecyclePolicy,
    ...(adapterManifest !== undefined ? { adapterManifest } : {}),
    ...(sidecarOperationTimeoutMs !== undefined
      ? { operationTimeoutMs: sidecarOperationTimeoutMs }
      : {}),
  });
  const sidecarAllocationStore = createSidecarAllocationStore(db, {
    getSidecarInventory: sidecarRouter.getSidecarInventory,
  });
  const workflowRunReader = createWorkflowRunReader(agentRepoStore.repoStore);
  const launchSpecs = createWorkflowRunLaunchSpecStore(db);
  const classifyParkedRun = createParkedRunClassifier({
    runReader: workflowRunReader,
    addressForAnchor: async (anchorRunId) => {
      const row = await db.query.workflowRun.findFirst({
        where: (run, { eq: equals }) => equals(run.id, anchorRunId),
        columns: { address: true },
      });
      return row?.address ?? null;
    },
    projectionForAnchor: async (anchorRunId) => {
      const spec = await launchSpecs.get(anchorRunId);
      return spec?.frozenApprovalBundle.projection ?? null;
    },
  });
  const workflowLifecycleService = createWorkflowLifecycleService({
    db,
    retentionRouter: sidecarRouter,
    runReader: workflowRunReader,
    historyReceives: workflowHistoryReceives,
    sendControl: (target, command, timeoutMs) =>
      sidecarRouter.sendWorkflowControl(target, command, timeoutMs),
  });
  const dispatchProjection = createWorkflowDispatchProjection({
    db,
    repoStore: agentRepoStore.repoStore,
  });
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
    maxConcurrentClaims: sidecarAllocationConcurrency,
    plugins: sidecarPlugins,
    router: sidecarRouter,
    hubWebSocketUrl: hubSidecarWebSocketUrl,
    ...(adapterManifest !== undefined ? { adapterManifest } : {}),
    ...(sidecarOperationTimeoutMs !== undefined
      ? { operationTimeoutMs: sidecarOperationTimeoutMs }
      : {}),
    onInitializationRecovery: (allocation, reconciliation) =>
      recoverSenderDeploy({ db, sidecarRouter, allocation, reconciliation }),
    classifyParkedRun,
    onReady: async (allocation, reconciliation) => {
      await workflowAllocationService.deployReadyAllocation(allocation, reconciliation);
      reconciliation.signal.throwIfAborted();
      await workflowDispatchService.requeueForReadyAllocation(allocation.anchorRunId);
    },
  });

  await workflowAllocationService.initialize?.();
  await sidecarAllocationReconciler.initialize();
  attachSidecarProvisioners({
    provisioners: [...deploymentProvisioners, ...probeProvisioners],
    retireProvisionerSidecar: sidecarAllocationStore.retireProvisionerSidecar,
    isConnected: sidecarRouter.holdsAllocatedBinding,
  });
  sidecarRouter.events.on("sidecar.disconnect", async ({ allocated }) => {
    await Promise.all(
      allocated.map((target) =>
        sidecarAllocationReconciler.handleDisconnect(target).catch((err: unknown) => {
          log.error(
            "Failed to handle the disconnect of allocation {allocationId} generation {generation}: {error}",
            {
              allocationId: target.allocationId,
              generation: target.generation,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }),
      ),
    );
  });
  sidecarRouter.events.on("sidecar.allocated.connected", (allocated) =>
    sidecarAllocationReconciler.handleConnected(allocated),
  );
  sidecarRouter.events.on("deployment.stopped", (allocated) =>
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
  const lifecycleScheduler = createReconciliationScheduler({
    name: "Workflow lifecycle",
    reconcileNext: () => workflowLifecycleService.reconcileNext(),
  });
  const dispatchScheduler = createReconciliationScheduler({
    name: "Workflow dispatch",
    concurrency: 1,
    reconcileNext: async () => {
      await workflowDispatchService.reconcileUntilIdle();
      return false;
    },
  });
  const dispatchProjectionScheduler = createReconciliationScheduler({
    name: "Workflow dispatch projection",
    concurrency: DEFAULT_WORKFLOW_PROJECTION_CONCURRENCY,
    reconcileNext: async () => {
      await dispatchProjection.reconcileNext();
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
  lifecycleScheduler.start();
  dispatchProjectionScheduler.start();
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
    workflowLifecycleService,
    eventCollectors,
    credentialCipher,
    principalKeyStore,
    assetService,
    repoStore: agentRepoStore.repoStore,
    maxTarballBytes: hubMaxTarballBytes,
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

  const corbits = mountCorbits({
    app,
    db,
    port,
    grantStore,
    principalKeyStore,
    credentialCipher,
    sidecarRouter,
    lookups,
  });

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
    async shutdown(): Promise<void> {
      allocationScheduler.stop();
      probeCleanupScheduler.stop();
      lifecycleScheduler.stop();
      dispatchProjectionScheduler.stop();
      dispatchScheduler.stop();
      connectionRepairScheduler.stop();
      corbits.stop();
      await closeDb();
    },
  };
}
