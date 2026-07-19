import fs from "node:fs/promises";
import path from "node:path";
import { setupObservability } from "@workbench/sentry";
import { createInMemoryTransport } from "@intx/mail-memory";
import {
  createEd25519Crypto,
  generateKeyPair,
  signEd25519,
  verifySSHSignature,
} from "@intx/crypto";
import { createSidecarOrchestrator, type HubLink } from "@workbench/hub-agent";
import type { InferenceEvent } from "@intx/types/runtime";
import { hexEncode } from "@intx/types";
import { createAgentRepoStore } from "@intx/hub-sessions";
import { buildWorkbenchAdapterRegistry } from "./gemini-thought-signature-patch";
import { wsUrlToHttp } from "./agent-tools";
import {
  readAdapterManifest,
  resolveSidecarHeartbeat,
  resolveSidecarHubLinkQueue,
  resolveSidecarSpawnReadyTimeoutMs,
  resolveToolPackageCache,
  resolveWorkflowRunPackLimits,
} from "./config";
// Workflow-host wiring: `createSidecarDeployRouter` is the production
// deploy routing the orchestrator hands to the link's `agent.deploy`
// handler. Every deploy stages through a workflow-host supervisor on the
// workflow-run substrate; the in-process single-agent harness runtime is
// retired.
import {
  createSidecarDeployRouter,
  type SidecarDeployRouter,
} from "./workflow-host-wiring";
import { reconcileOrphanedDeploymentDirs } from "./boot-reconciler";
import { getLogger } from "@intx/log";
import { startMemoryTelemetry, startPeriodicGc } from "./memory-telemetry";
import {
  createDeploymentAddressRegistry,
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createMultistepSourcesRouter,
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

// Operator-configured custom inference adapters, resolved once at the
// boot edge. `buildWorkbenchAdapterRegistry` merges the statically-linked
// built-ins with any custom adapters the manifest names, importing each
// custom module eagerly here so a bad specifier fails the sidecar at
// boot rather than at first inference. The registry gates deploy-time
// source admission (`assertSourceBuildable` below); the workflow
// child cannot receive this object across the fork, so the validated
// manifest is serialized into the child's spawn env (see
// `multistepSubstrateEnv`) and the child rebuilds an equivalent
// registry from it. The registry is wrapped with the google-genai
// thoughtSignature workaround (BD-394) so every resolved google-genai
// adapter strips orphan `thoughtSignature` parts the upstream parser
// cannot handle — remove the wrap once fixed upstream.
const adapterManifest = readAdapterManifest();
const adapters = await buildWorkbenchAdapterRegistry(adapterManifest);

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
// Single-step (warm launched-agent) deployments register a sources-rotation
// handler here once their supervisor spawns; the hub-link routes an inbound
// `sources.update` frame through it. A multi-step deployment registers none,
// so its address is reported unrouted.
const multistepSourcesRouter = createMultistepSourcesRouter();

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
  SIDECAR_SIGNING_PUBLIC_KEY: hexEncode(sidecarSigningKey.publicKey),
  SIDECAR_SIGNING_PRIVATE_KEY: hexEncode(sidecarSigningKey.privateKey),
  HUB_WS_URL: hubWsUrl,
  SIDECAR_ID: sidecarId,
  SIDECAR_TOKEN: sidecarToken,
  PATH: requireEnv("PATH"),
  SIDECAR_CACHE_MAX_BYTES: String(toolPackageCache.cacheMaxBytes),
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: String(
    toolPackageCache.registryMaxTarballBytes,
  ),
  // Serialize the parent's ALREADY-VALIDATED manifest (the object
  // `readAdapterManifest` returned), not the raw env string, so the
  // child rebuilds the same custom-adapter set. Always present (defaults
  // to "[]" when no custom adapters are configured); the child treats a
  // missing key as a serialization bug and fails loud. The child
  // re-validates the shape before importing any module — defense in
  // depth at the deserialization boundary, since the child env is
  // operator-controlled via Bun.spawn.
  SIDECAR_ADAPTER_MANIFEST: JSON.stringify(adapterManifest),
};
// CL-2503: thread the sidecar's Sentry config to the workflow-child via the
// spawn-time substrate env. The supervisor spawns the child with a FRESH env
// (no inheritance of the sidecar's process env), and the workflow-child is
// where every workflow STEP actually runs and throws — without this it
// initializes no Sentry, so step failures (and their stacks) never reach
// Sentry. Optional like HOME/TMPDIR: an absent DSN leaves the child
// console-only, exactly as the sidecar process behaves locally.
const sentryDsn = process.env["SENTRY_DSN"];
if (sentryDsn !== undefined) {
  multistepSubstrateEnv["SENTRY_DSN"] = sentryDsn;
}
const sentryEnvironment = process.env["SENTRY_ENVIRONMENT"];
if (sentryEnvironment !== undefined) {
  multistepSubstrateEnv["SENTRY_ENVIRONMENT"] = sentryEnvironment;
}
// CL-2503: the child derives its log format from NODE_ENV (dev = pretty,
// production = structured JSON). Without threading it the child sees it
// undefined and logs dev-formatted in production, diverging from the sidecar.
const hostNodeEnv = process.env["NODE_ENV"];
if (hostNodeEnv !== undefined) {
  multistepSubstrateEnv["NODE_ENV"] = hostNodeEnv;
}
const hostHome = process.env["HOME"];
if (hostHome !== undefined) {
  multistepSubstrateEnv["HOME"] = hostHome;
}
const hostTmpdir = process.env["TMPDIR"];
if (hostTmpdir !== undefined) {
  multistepSubstrateEnv["TMPDIR"] = hostTmpdir;
}

// The deploy router computes a deployment's on-disk reclaim path
// (workflow-runs/<id>) from `multistepSubstrateEnv.SIDECAR_DATA_DIR`
// (`stepStateDataDir`), while the substrate roots its workflow-run repos under
// the AgentRepoStore's own `dataDir`. Teardown/boot-reconciler reclaim
// correctness depends on both being the SAME root: a directory reclaimed under
// one root while the substrate writes under another leaks terminated
// deployments' state. Both derive from the single `dataDir` env today, but
// nothing structurally forces it — tie the two together at boot and fail loud
// if a future config split diverges them.
const substrateWorkflowRunRoot = agentRepoStore.repoStore.getRepoDir({
  kind: "workflow-run",
  id: "__data_dir_invariant_probe__",
});
if (!substrateWorkflowRunRoot.startsWith(dataDir)) {
  throw new Error(
    `sidecar boot: workflow-run substrate root (${substrateWorkflowRunRoot}) is not under the deploy router's reclaim root SIDECAR_DATA_DIR (${dataDir}); deployment-dir reclaim would target the wrong directory and leak terminated deployments' state`,
  );
}

// The deploy-router handle, captured during `createDeployRouter` (which the
// orchestrator invokes synchronously inside its constructor). The boot edge
// needs it after construction to restore persisted deployments and to answer
// the hub-link's `getWorkflowAddresses` announcement. Held in a box so reads
// after the closure assignment see the declared type, not `null`.
const deployRouterBox: { current: SidecarDeployRouter | null } = {
  current: null,
};

const orchestrator = createSidecarOrchestrator({
  hubURL: hubWsUrl,
  sidecarId,
  token: sidecarToken,
  dataDir,
  pingIntervalMs: heartbeat.pingIntervalMs,
  reconnectDelayMs: heartbeat.reconnectDelayMs,
  maxReconnectDelayMs: heartbeat.maxReconnectDelayMs,
  // WORKBENCH-LOCAL (CL-3826)
  connectTimeoutMs: heartbeat.connectTimeoutMs,
  maxOutboundQueue: hubLinkQueue.maxOutboundQueue,
  transport,
  cryptoOps: {
    generateKeyPair,
    signEd25519,
    verifySSHSig: verifySSHSignature,
  },
  mailInboundRouter: multistepMailRouter,
  signalInboundRouter: multistepSignalRouter,
  drainInboundRouter: multistepDrainRouter,
  sourcesInboundRouter: multistepSourcesRouter,
  // Announce the workflow-deployment addresses this sidecar hosts on every
  // (re)connect so the hub re-challenges and re-routes them.
  getWorkflowAddresses: () => deployRouterBox.current?.activeAddresses() ?? [],
  // Gate the workflow-run pack pusher on hub routability: block a deployment's
  // pushes on WS disconnect, and re-drive them once the reconnect challenge
  // re-routes the address.
  onWorkflowAddressesRoutable: (addresses) => {
    for (const address of addresses) {
      wrappedRepoStore.notifyAddressRoutable(address);
    }
  },
  onWorkflowAddressesUnroutable: (addresses) => {
    for (const address of addresses) {
      wrappedRepoStore.markAddressUnroutable(address);
    }
  },
  createDeployRouter: ({ sessions, keyStore }) => {
    const router = createSidecarDeployRouter({
      sessions,
      keyStore,
      transport,
      repoStore: wrappedRepoStore,
      signingKeySeed: sidecarSigningKey.privateKey,
      createAgentCrypto: createEd25519Crypto,
      // Source-admission gate: reject a deploy pinning a provider this sidecar
      // cannot build, on the control plane rather than at first inference.
      assertSourceBuildable: (source) => {
        if (!adapters.has(source.provider)) {
          throw new Error(
            `Source provider "${source.provider}" is not registered`,
          );
        }
      },
      // Spawn-readiness deadline held STRICTLY below the hub's 30s deploy wait
      // so a too-slow cold spawn fails on the sidecar (structured error ack)
      // inside the hub's window instead of racing it to an ambiguous hub-side
      // timeout that drops the waking mail. See config.ts for the margin.
      readyTimeoutMs: resolveSidecarSpawnReadyTimeoutMs(process.env),
      registerDeployment: ({ deploymentId, agentAddress }) => {
        deploymentAddressRegistry.record(deploymentId, agentAddress);
      },
      drainWorkflowRunPushes: (deploymentId) =>
        wrappedRepoStore.flushWorkflowRunPushes(
          { kind: "workflow-run", id: deploymentId },
          "refs/heads/main",
        ),
      unregisterDeployment: ({ deploymentId }) => {
        // The pack client's per-deployment cursor lifecycle converged upstream
        // (commitPackedTip advances only on ack, resets only on a fresh
        // createPack), so there is no forgetDeployment to call here.
        deploymentAddressRegistry.unregister(deploymentId);
      },
      multistepMailRouter,
      multistepSignalRouter,
      multistepDrainRouter,
      multistepSourcesRouter,
      multistepSubstrateEnv,
      publishWorkflowInferenceEvent: (agentAddress, event, sessionId) => {
        if (sessionId === undefined) return;
        workflowInferencePublisher.send?.(agentAddress, sessionId, event);
      },
    });
    deployRouterBox.current = router;
    return router;
  },
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

// No boot-time deployment restore (CL-3884): the sidecar boots empty and the
// hub — the control plane — re-deploys what should be resident (mail-wake for
// idle agents, gate signals + the awaiting prewarm for parked runs; the run
// liveness sweep fails running runs whose child died with the process).

orchestrator.start();

// Always-on memory observability (rss/heap/external) + on-demand heap snapshot
// via SIGUSR2 → dataDir, so the sidecar's resident-heap composition is
// measurable in prod without a redeploy.
startMemoryTelemetry(dataDir);

// Bun/mimalloc does not return freed heap to the OS on its own, so a slept
// agent's turn memory stays in RSS until a GC is forced. Periodically force one
// so memory tracks live load instead of the peak high-water-mark (CL-2813).
startPeriodicGc();
