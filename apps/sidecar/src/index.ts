import fs from "node:fs/promises";
import path from "node:path";
import { sign as nodeSign } from "node:crypto";
import { setupObservability } from "@workbench/sentry";
import { createInMemoryTransport } from "@intx/mail-memory";
import {
  createNodeCrypto,
  generateKeyPair,
  importPrivateKeyBytes,
  verifySSHSignature,
} from "@intx/crypto-node";
import { createSidecarOrchestrator, type HubLink } from "@workbench/hub-agent";
import type { InferenceEvent } from "@intx/types/runtime";
import { createAgentRepoStore } from "@intx/hub-sessions";
import { installGeminiThoughtSignaturePatch } from "./gemini-thought-signature-patch";
import { createDefaultHarnessBuilder, wsUrlToHttp } from "./default-harness";
import {
  resolveSidecarHeartbeat,
  resolveSidecarHubLinkQueue,
  resolveToolPackageCache,
  resolveWorkflowRunPackLimits,
} from "./config";
// Workflow-host wiring: `createSidecarDeployRouter` is the production
// deploy routing the orchestrator hands to the link's `agent.deploy`
// handler. Every inbound frame flows through a freshly-constructed
// workflow-host supervisor whose trivial branch calls back into the
// sidecar's existing single-agent provisioning surface.
import { createSidecarDeployRouter } from "./workflow-host-wiring";
import { reconcileOrphanedDeploymentDirs } from "./boot-reconciler";
import { getLogger } from "@intx/log";
import {
  createDeploymentAddressRegistry,
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createWorkflowRunPackClient,
  createWorkflowRunPackPushingRepoStore,
} from "./workflow-run-pack-client";

// The workflow-run failure path logs at `warning`, not `error`, so these
// categories are invisible to Sentry by default. Route just the
// high-signal failure subtrees: supervisor replay failures and run-pack push
// failures (incl. `reason=corrupt`). The WS category
// (`interchange·hub-agent·ws`) is intentionally excluded — its transient
// reconnect warnings would flood Sentry.
await setupObservability(
  { dev: process.env.NODE_ENV !== "production" },
  {
    warnCategoryPrefixes: [
      ["workflow-host"],
      ["interchange", "sidecar", "workflow-run-pack-client"],
    ],
  },
);

// Install the google-genai thoughtSignature workaround before any inference
// happens. This wraps the registered adapter to strip orphan
// `thoughtSignature` parts that Gemini 3.x models emit, which the upstream
// parser cannot handle (BD-394). Remove once the vendored Interchange commit
// contains the fix.
installGeminiThoughtSignaturePatch();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const heartbeat = resolveSidecarHeartbeat(process.env);
const hubLinkQueue = resolveSidecarHubLinkQueue(process.env);
const dataDir = requireEnv("SIDECAR_DATA_DIR");
const toolPackageCache = resolveToolPackageCache(process.env, dataDir);

const hubWsUrl = requireEnv("HUB_WS_URL");
const sidecarId = requireEnv("SIDECAR_ID");
const sidecarToken = requireEnv("SIDECAR_TOKEN");

// Load or mint the sidecar's local Ed25519 keypair. The supervisor
// principal signs every workflow-run commit with this key; the
// substrate's signing callback signs every SSH-signed commit with it;
// the workflow-host child re-uses it via the `SIDECAR_SIGNING_*`
// spawn-time env vars. One key, one identity for the sidecar process.
const SIDECAR_SIGNING_DIR = path.join(dataDir, ".sidecar-signing");
const SIDECAR_PRIVATE_KEY_PATH = path.join(
  SIDECAR_SIGNING_DIR,
  "ed25519.private",
);
const SIDECAR_PUBLIC_KEY_PATH = path.join(
  SIDECAR_SIGNING_DIR,
  "ed25519.public",
);

async function loadOrMintSidecarKeypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  let havePriv = false;
  let havePub = false;
  try {
    await fs.access(SIDECAR_PRIVATE_KEY_PATH);
    havePriv = true;
  } catch {
    havePriv = false;
  }
  try {
    await fs.access(SIDECAR_PUBLIC_KEY_PATH);
    havePub = true;
  } catch {
    havePub = false;
  }
  if (havePriv !== havePub) {
    throw new Error(
      `sidecar signing keypair under ${SIDECAR_SIGNING_DIR} is partial: privateKey=${String(havePriv)} publicKey=${String(havePub)}; remove the directory to reset`,
    );
  }
  if (havePriv && havePub) {
    const [priv, pub] = await Promise.all([
      fs.readFile(SIDECAR_PRIVATE_KEY_PATH),
      fs.readFile(SIDECAR_PUBLIC_KEY_PATH),
    ]);
    return { privateKey: new Uint8Array(priv), publicKey: new Uint8Array(pub) };
  }
  const keyPair = await generateKeyPair();
  await fs.mkdir(SIDECAR_SIGNING_DIR, { recursive: true });
  await Promise.all([
    fs.writeFile(SIDECAR_PRIVATE_KEY_PATH, keyPair.privateKey, { mode: 0o600 }),
    fs.writeFile(SIDECAR_PUBLIC_KEY_PATH, keyPair.publicKey),
  ]);
  return keyPair;
}

const sidecarSigningKey = await loadOrMintSidecarKeypair();

// Substrate-backed RepoStore for workflow-run writes. The supervisor
// consumes this through the deploy router; the boot-edge facade below
// wraps it so a successful workflow-run write fires the pack push hook
// before its Promise resolves.
const agentRepoStore = createAgentRepoStore({
  dataDir,
  signingKey: sidecarSigningKey,
});

// `(deploymentId -> agentAddress)` map the deploy router records on
// every inbound `agent.deploy`; the facade resolves it when firing the
// pack push so outbound frames carry the right agentAddress.
const deploymentAddressRegistry = createDeploymentAddressRegistry();

// Per-deployment-address mail/signal/drain handler registries the
// hub-link consults before falling back to the legacy session path. The
// multi-step deploy router registers handlers against the deployment's
// mail address once its supervisor spawns.
const multistepMailRouter = createMultistepMailRouter();
const multistepSignalRouter = createMultistepSignalRouter();
const multistepDrainRouter = createMultistepDrainRouter();

const transport = createInMemoryTransport();

// The pack-push client closes over the substrate (for `createPack`) and a
// lazy hub-link binding (for `pushWorkflowRunPack`). The link reference is
// set once the orchestrator is constructed, because the orchestrator
// factory calls `createDeployRouter` during its constructor — before the
// orchestrator handle is bound.
let resolvedHubLink: HubLink | null = null;
const workflowRunPackClient = createWorkflowRunPackClient({
  substrate: agentRepoStore.repoStore,
  limits: resolveWorkflowRunPackLimits(process.env),
  hubLink: {
    pushWorkflowRunPack(opts) {
      if (resolvedHubLink === null) {
        throw new Error(
          "sidecar boot: workflow-run pack push attempted before hub link was constructed",
        );
      }
      return resolvedHubLink.pushWorkflowRunPack(opts);
    },
  },
});

// Wrap the substrate's RepoStore with the boot-edge facade so a successful
// supervisor write against a workflow-run repo fires the pack push hook
// before its Promise resolves. Non-workflow-run writes flow through
// unchanged.
const wrappedRepoStore = createWorkflowRunPackPushingRepoStore({
  underlying: agentRepoStore.repoStore,
  packClient: workflowRunPackClient,
  registry: deploymentAddressRegistry,
});

// Multi-step substrate-config the deploy router threads into the
// workflow-process child's spawn-time env. `PATH`, `HOME`, and `TMPDIR`
// are propagated so the child's `#!/usr/bin/env bun` shebang can resolve
// `bun`, agent code can find a writable home, and tmp-file APIs land on
// the same temp root the host uses.
const workflowInferencePublisher: {
  send?: (
    agentAddress: string,
    sessionId: string,
    event: InferenceEvent,
  ) => void;
} = {};

const multistepSubstrateEnv: Record<string, string> = {
  SIDECAR_DATA_DIR: dataDir,
  SIDECAR_SIGNING_PUBLIC_KEY: Buffer.from(sidecarSigningKey.publicKey).toString(
    "hex",
  ),
  SIDECAR_SIGNING_PRIVATE_KEY: Buffer.from(
    sidecarSigningKey.privateKey,
  ).toString("hex"),
  HUB_WS_URL: hubWsUrl,
  SIDECAR_ID: sidecarId,
  SIDECAR_TOKEN: sidecarToken,
  PATH: requireEnv("PATH"),
  SIDECAR_CACHE_MAX_BYTES: String(toolPackageCache.cacheMaxBytes),
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: String(
    toolPackageCache.registryMaxTarballBytes,
  ),
};
const hostHome = process.env["HOME"];
if (hostHome !== undefined) {
  multistepSubstrateEnv["HOME"] = hostHome;
}
const hostTmpdir = process.env["TMPDIR"];
if (hostTmpdir !== undefined) {
  multistepSubstrateEnv["TMPDIR"] = hostTmpdir;
}

const orchestrator = createSidecarOrchestrator({
  hubURL: hubWsUrl,
  sidecarId,
  token: sidecarToken,
  dataDir,
  pingIntervalMs: heartbeat.pingIntervalMs,
  reconnectDelayMs: heartbeat.reconnectDelayMs,
  maxOutboundQueue: hubLinkQueue.maxOutboundQueue,
  transport,
  buildHarness: createDefaultHarnessBuilder({
    hubHttpUrl: wsUrlToHttp(hubWsUrl),
    sidecarToken,
    cacheRoot: toolPackageCache.cacheRoot,
    cacheMaxBytes: toolPackageCache.cacheMaxBytes,
    registryMaxTarballBytes: toolPackageCache.registryMaxTarballBytes,
  }),
  createAgentCrypto: createNodeCrypto,
  cryptoOps: {
    generateKeyPair,
    signEd25519(privateKey, payload) {
      const key = importPrivateKeyBytes(privateKey);
      return new Uint8Array(nodeSign(null, payload, key));
    },
    verifySSHSig: verifySSHSignature,
  },
  mailInboundRouter: multistepMailRouter,
  signalInboundRouter: multistepSignalRouter,
  drainInboundRouter: multistepDrainRouter,
  createDeployRouter: ({ sessions, keyStore, onAgentEvent }) =>
    createSidecarDeployRouter({
      sessions,
      keyStore,
      onAgentEvent,
      transport,
      repoStore: wrappedRepoStore,
      signingKeySeed: sidecarSigningKey.privateKey,
      createAgentCrypto: createNodeCrypto,
      registerDeployment: ({ deploymentId, agentAddress }) => {
        deploymentAddressRegistry.record(deploymentId, agentAddress);
      },
      drainWorkflowRunPushes: (deploymentId) =>
        wrappedRepoStore.flushWorkflowRunPushes(
          { kind: "workflow-run", id: deploymentId },
          "refs/heads/main",
        ),
      unregisterDeployment: ({ deploymentId }) => {
        deploymentAddressRegistry.unregister(deploymentId);
        workflowRunPackClient.forgetDeployment(deploymentId);
      },
      multistepMailRouter,
      multistepSignalRouter,
      multistepDrainRouter,
      multistepSubstrateEnv,
      publishWorkflowInferenceEvent: (agentAddress, event, sessionId) => {
        if (sessionId === undefined) return;
        workflowInferencePublisher.send?.(agentAddress, sessionId, event);
      },
    }),
});

resolvedHubLink = orchestrator.hubLink;
workflowInferencePublisher.send = orchestrator.hubLink.sendEvent;

// Prune orphaned on-disk deployment dirs BEFORE the orchestrator's hub-link
// connects, so interchange's `restoreSessions()` never re-establishes
// deployments the hub has soft-deleted/superseded (CL-2231 part 2). The
// reconciler is fail-safe (deletes nothing unless it positively confirms the
// hub's live set), and a throw here must NEVER prevent the sidecar from
// starting — wrap and continue.
try {
  await reconcileOrphanedDeploymentDirs({
    dataDir,
    hubHttpUrl: wsUrlToHttp(hubWsUrl),
    sidecarToken,
  });
} catch (err) {
  // Defensive: the reconciler swallows its own failures, but a thrown error
  // (e.g. an unexpected logger fault) must not gate boot.
  getLogger(["sidecar", "boot"]).error(
    "boot reconciler threw; continuing sidecar start: {msg}",
    {
      msg: err instanceof Error ? err.message : String(err),
    },
  );
}

orchestrator.start();
