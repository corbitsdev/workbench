import { appendFileSync } from "node:fs";
import path from "node:path";
import { setup } from "@intx/log";
import { createInMemoryTransport } from "@intx/mail-memory";
import {
  createEd25519Crypto,
  createEnvKeyCredentialCipher,
  generateKeyPair,
  verifySSHSignature,
} from "@intx/crypto";
import {
  createSenderKeyCache,
  createSenderCryptoResolver,
  createInboundMailPolicyRegistry,
  createInboundMailPolicyLookup,
  createSidecarOrchestrator,
  type HubLink,
} from "@intx/hub-agent";
import { hexDecode, hexEncode } from "@intx/types";
import { createAgentRepoStore } from "@intx/hub-sessions";
import { createTarballCache } from "@intx/tool-packaging";

import { loadAdapterRegistry } from "@intx/inference/providers";

import {
  readAdapterManifest,
  readCacheMaxBytes,
  readCredentialEncryptionKey,
  readRegistryMaxTarballBytes,
} from "./config";
import { createDefaultHarnessBuilder } from "./default-harness";
// `createSidecarDeployRouter` is the production routing the
// orchestrator hands to the link's `agent.deploy` handler; every
// inbound frame stages through the workflow-run substrate, spawning a
// supervised workflow-process child for a workflow deploy.
import type { DispatchTimingMark } from "@intx/workflow-host";

import { createSidecarDeployRouter, type SidecarDeployRouter } from "./workflow-host-wiring";
import {
  createDeploymentAddressRegistry,
  createMultistepDrainRouter,
  createMultistepGrantsRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createMultistepSourcesRouter,
  createMultistepCredentialsRouter,
  createWorkflowRunPackClient,
  createWorkflowRunPackPushingRepoStore,
} from "./workflow-run-pack-client";
import { createWorkflowRunPackRestorer } from "./workflow-run-pack-restore";
import { readRegistries } from "./sidecar-materialization-config";
import { createWorkflowClosureMaterializer } from "./workflow-closure-materialization";
import { MAX_INLINE_ASSET_PAYLOAD_BYTES } from "./source-asset-delivery";
import { createWorkflowProbeExecutor } from "./workflow-probe-handler";
import { loadOrMintSidecarKeypair } from "./signing-keypair";
import { removeFileAtomicDurable, writeFileAtomicDurable } from "./atomic-write";

await setup();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const dataDir = requireEnv("SIDECAR_DATA_DIR");

// The sidecar seals its at-rest credential material (run-record apiKeys, and
// the tool credential store) under this operator key. Constructed at the boot
// edge so a missing or malformed key fails loudly here rather than when the
// first record is persisted.
const credentialCipher = createEnvKeyCredentialCipher(readCredentialEncryptionKey());

// Resolve cache configuration at the boot edge so the workflow-child's
// per-apply loader receives a concrete path and cap through its spawn
// env rather than re-reading env at non-boundary call sites.
const sidecarCacheDir = process.env["SIDECAR_CACHE_DIR"];
const cacheRoot =
  sidecarCacheDir !== undefined && sidecarCacheDir.trim() !== ""
    ? sidecarCacheDir
    : path.join(dataDir, "cache", "tarballs");
const cacheMaxBytes = readCacheMaxBytes();
const registryMaxTarballBytes = readRegistryMaxTarballBytes();

// Custom modules import eagerly here so a bad specifier fails at boot,
// not first inference. The child rebuilds an equivalent registry from
// the serialized manifest since it can't receive this object across the fork.
const adapterManifest = readAdapterManifest();
const adapters = await loadAdapterRegistry(adapterManifest);

// A file, not stdout, since the spawn fixture caps its stdout drain buffer
// below what a few-hundred-message run emits. Observability-only; a failed
// append surfaces rather than silently yielding an empty result set.
const latencyBenchFile = process.env["SIDECAR_LATENCY_BENCH_FILE"];
const onDispatchTiming: ((mark: DispatchTimingMark) => void) | undefined =
  latencyBenchFile !== undefined && latencyBenchFile.trim() !== ""
    ? (mark) => {
        let line: string;
        if (mark.kind === "roundtrip") {
          line = `${mark.messageId} ${mark.marker} ${mark.atMs.toFixed(3)}\n`;
        } else {
          const counters =
            mark.counters !== undefined
              ? ` ${String(mark.counters.runsFanOut)} ${String(mark.counters.consumedFanOut)} ${String(mark.counters.looseObjects)} ${String(mark.counters.gitBytes)}`
              : "";
          line = `${mark.messageId} leg ${mark.leg} ${mark.phase} ${mark.atMs.toFixed(3)}${counters}\n`;
        }
        appendFileSync(latencyBenchFile, line);
      }
    : undefined;

// Measurement-only: forces a repack every Nth message to discriminate
// pack-growth from tree-fan-out, never to run in production.
const repackEveryRaw = process.env["SIDECAR_REPACK_EVERY_MESSAGES"];
let repackEveryMessages: { everyMessages: number } | undefined;
if (repackEveryRaw !== undefined && repackEveryRaw.trim() !== "") {
  const parsed = Number.parseInt(repackEveryRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `SIDECAR_REPACK_EVERY_MESSAGES must be a positive integer, got ${repackEveryRaw}`,
    );
  }
  repackEveryMessages = { everyMessages: parsed };
}

// The longest window a re-submitted message must still be caught as a
// duplicate; must be >= the max redelivery window of any at-least-once source.
const consumedRetentionRaw = process.env["CONSUMED_RETENTION_MS"];
let consumedRetentionMs: number | undefined;
if (consumedRetentionRaw !== undefined && consumedRetentionRaw.trim() !== "") {
  const parsed = Number.parseInt(consumedRetentionRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CONSUMED_RETENTION_MS must be a positive integer (milliseconds), got ${consumedRetentionRaw}`,
    );
  }
  consumedRetentionMs = parsed;
}

// On expiry the supervisor kills the child and rejects the spawn, so a
// child that never signals ready fails the deploy instead of hanging it.
const readyTimeoutRaw = process.env["CHILD_READY_TIMEOUT_MS"];
let readyTimeoutMs: number | undefined;
if (readyTimeoutRaw !== undefined && readyTimeoutRaw.trim() !== "") {
  const parsed = Number.parseInt(readyTimeoutRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CHILD_READY_TIMEOUT_MS must be a positive integer (milliseconds), got ${readyTimeoutRaw}`,
    );
  }
  readyTimeoutMs = parsed;
}

// Production never sets this; test harnesses set a short value so
// reconnect tests don't burn 3s of wall clock per dropped link.
const reconnectDelayRaw = process.env["SIDECAR_RECONNECT_DELAY_MS"];
let reconnectDelayMs: number | undefined;
if (reconnectDelayRaw !== undefined && reconnectDelayRaw.trim() !== "") {
  const parsed = Number.parseInt(reconnectDelayRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `SIDECAR_RECONNECT_DELAY_MS must be a positive integer (milliseconds), got ${reconnectDelayRaw}`,
    );
  }
  reconnectDelayMs = parsed;
}

// Sweeps orphaned tmp staging dirs left by a crash between staging and
// rename on a previous boot.
await createTarballCache({
  rootDir: cacheRoot,
  maxBytes: cacheMaxBytes,
}).sweepOrphans();

// One key, one identity: signs every workflow-run commit and every
// SSH-signed commit, and is re-used by the child via spawn-time env vars.
const SIDECAR_SIGNING_DIR = path.join(dataDir, ".sidecar-signing");

const sidecarSigningKey = await loadOrMintSidecarKeypair(SIDECAR_SIGNING_DIR);

// Wrapped below by the boot-edge facade so a successful workflow-run
// write fires the pack push hook before its Promise resolves.
const agentRepoStore = createAgentRepoStore({
  dataDir,
  signingKey: sidecarSigningKey,
});

// Loaded here at boot so a restart keeps every previously-cached key; the
// durable-write primitive is injected so the write stays at least as
// durable as the run-grants write it gates.
const senderKeyCache = await createSenderKeyCache({
  dataDir,
  writeFileDurable: (filePath, contents) =>
    writeFileAtomicDurable(filePath, contents, { mode: 0o600 }),
  removeFileDurable: (filePath) => removeFileAtomicDurable(filePath),
});

// Built here so the hub link stays source-opaque, resolving address -> crypto
// without holding the cache or knowing where the key came from.
const resolveSenderCrypto = createSenderCryptoResolver(senderKeyCache);

// Mirrors resolveSenderCrypto's opacity for inbound-mail admission policies.
const inboundMailPolicyRegistry = createInboundMailPolicyRegistry();
const lookupInboundMailPolicy = createInboundMailPolicyLookup(inboundMailPolicyRegistry);

// The facade resolves this mapping when firing the pack push so outbound
// frames carry the right agentAddress for hub-side routing.
const deploymentAddressRegistry = createDeploymentAddressRegistry();

// Mail for an address with no registered handler is logged-and-dropped.
const multistepMailRouter = createMultistepMailRouter();

// The child commits the resulting SignalReceived through its own
// substrate, the single writer of the workflow-run repo sidecar-side.
const multistepSignalRouter = createMultistepSignalRouter();

// Cancel-mode in-flight steps abort child-side; wait-mode steps continue.
const multistepDrainRouter = createMultistepDrainRouter();

// The write is awaited so the frame's FIFO completion means grants are durable.
const multistepGrantsRouter = createMultistepGrantsRouter();

// Only a single-step warm deployment registers a handler; a multi-step
// deployment registers none, so a rotation against its address is unrouted.
const multistepSourcesRouter = createMultistepSourcesRouter();
// Per-deployment credential-delivery handler registry. A deployment registers
// its handler after `spawn` (any deployment with a supervisor, not only warm
// single-step ones); a `credentials.update` for an unregistered address is
// unrouted.
const multistepCredentialsRouter = createMultistepCredentialsRouter();

const transport = createInMemoryTransport();

// Consulted lazily since createSidecarOrchestrator calls createDeployRouter
// during its constructor, before the orchestrator handle is bound.
let resolvedHubLink: HubLink | null = null;
const workflowRunPackClient = createWorkflowRunPackClient({
  substrate: agentRepoStore.repoStore,
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
const restoreWorkflowRunPack = createWorkflowRunPackRestorer({
  // Restore into the unwrapped substrate. Running Hub-authored history
  // through the push facade would echo the same pack straight back to the
  // Hub and incorrectly present it as a new supervisor write.
  substrate: agentRepoStore.repoStore,
  markRestored: workflowRunPackClient.markRestored,
});

// Non-workflow-run writes (today, the agent-state deploy-applier path) flow through unchanged.
const wrappedRepoStore = createWorkflowRunPackPushingRepoStore({
  underlying: agentRepoStore.repoStore,
  packClient: workflowRunPackClient,
  registry: deploymentAddressRegistry,
});

const hubWsUrl = requireEnv("HUB_WS_URL");
const sidecarId = requireEnv("SIDECAR_ID");
const sidecarToken = requireEnv("SIDECAR_TOKEN");

// PATH/HOME/TMPDIR propagate from the boot edge so the child's shebang can
// resolve bun and tmp-file APIs land on the host's temp root; the
// SubstrateConfig validator ignores these as undeclared keys.
const multistepSubstrateEnv: Record<string, string> = {
  SIDECAR_DATA_DIR: dataDir,
  SIDECAR_SIGNING_PUBLIC_KEY: hexEncode(sidecarSigningKey.publicKey),
  SIDECAR_SIGNING_PRIVATE_KEY: hexEncode(sidecarSigningKey.privateKey),
  HUB_WS_URL: hubWsUrl,
  SIDECAR_ID: sidecarId,
  SIDECAR_TOKEN: sidecarToken,
  PATH: requireEnv("PATH"),
  SIDECAR_CACHE_MAX_BYTES: String(cacheMaxBytes),
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: String(registryMaxTarballBytes),
  // The already-validated manifest, not the raw env string, so the child
  // rebuilds the same set; the child re-validates before importing any module.
  SIDECAR_ADAPTER_MANIFEST: JSON.stringify(adapterManifest),
};
const hostHome = process.env["HOME"];
if (hostHome !== undefined) {
  multistepSubstrateEnv["HOME"] = hostHome;
}
const hostTmpdir = process.env["TMPDIR"];
if (hostTmpdir !== undefined) {
  multistepSubstrateEnv["TMPDIR"] = hostTmpdir;
}

// The deploy router's source-admission gate reuses this exact
// `canBuildSource` predicate, against the one adapter registry, rather
// than a second copy of the check.
const buildHarness = createDefaultHarnessBuilder({ adapters });

// Answers workflow.probe.request with a real inert projection instead of
// the hub-link's rejecting placeholder; scratch dir rooted here to share
// the sidecar data dir's lifecycle.
const workflowProbeExecutor = createWorkflowProbeExecutor({
  materialize: createWorkflowClosureMaterializer({
    cacheRoot,
    cacheMaxBytes,
    registryMaxTarballBytes,
    maxAssetPayloadBytes: MAX_INLINE_ASSET_PAYLOAD_BYTES,
    registries: readRegistries(),
    scratchRoot: path.join(dataDir, "workflow-probe", "closures"),
  }),
});

// Set by the `createDeployRouter` callback below (invoked synchronously
// during construction) so the boot edge can drive the router's restore pass
// before `orchestrator.start()` connects to the hub.
let sidecarDeployRouter: SidecarDeployRouter | undefined;

const orchestrator = createSidecarOrchestrator({
  hubURL: hubWsUrl,
  sidecarId,
  token: sidecarToken,
  dataDir,
  transport,
  cryptoOps: {
    generateKeyPair,
    verifySSHSig: verifySSHSignature,
  },
  resolveSenderCrypto,
  lookupInboundMailPolicy,
  // Write peer of `resolveSenderCrypto`: an inbound `sender.key.refresh` frame
  // re-pushes a rotated sender key here. Decode the hex and persist through the
  // same cache the read side serves from; `put` owns the 32-byte length check
  // and `hexDecode` owns hex validity, so both faults surface to the link's
  // handler rather than being masked here.
  cacheSenderKey: (address, publicKey) => senderKeyCache.put(address, hexDecode(publicKey)),
  // Evicting peer of `cacheSenderKey`: an inbound `sender.key.evict` frame
  // durably removes a revoked sender's cached key through the same cache.
  evictSenderKey: (address) => senderKeyCache.evict(address),
  mailInboundRouter: multistepMailRouter,
  signalInboundRouter: multistepSignalRouter,
  drainInboundRouter: multistepDrainRouter,
  grantsInboundRouter: multistepGrantsRouter,
  sourcesInboundRouter: multistepSourcesRouter,
  credentialsInboundRouter: multistepCredentialsRouter,
  applyWorkflowRunPack: restoreWorkflowRunPack,
  workflowProbeExecutor,
  // Test-only override of the hub-link reconnect backoff; unset in
  // production, where the link applies its 3s default.
  ...(reconnectDelayMs !== undefined ? { reconnectDelayMs } : {}),
  // The hub link calls this on every (re)connect to announce the workflow
  // deployments this sidecar hosts so the hub re-registers their routes.
  // `createDeployRouter` runs synchronously during construction (below), so
  // the router is captured before the link ever connects; assert rather than
  // optional-chain so a wiring regression fails loud instead of silently
  // announcing no deployments.
  getWorkflowAddresses: () => {
    if (sidecarDeployRouter === undefined) {
      throw new Error(
        "sidecar boot: deploy router was not constructed before the hub link requested workflow addresses",
      );
    }
    return sidecarDeployRouter.activeAddresses();
  },
  // Report the sidecar's cached rotatable senders on every (re)connect so the
  // hub re-resolves each current key and re-pushes it, catching a rotation that
  // landed while the sidecar was disconnected. The cache owns the "only user
  // senders rotate" filter (a run sender's key is the immutable
  // workflow_run.public_key); the link stays source-opaque and reports whatever
  // this returns.
  getCachedSenderAddresses: () => senderKeyCache.rotatableAddresses(),
  // Re-drives a pack the disconnect cancelled; fires after the reconnect frame
  // since both frame families queue on the hub's per-connection chain.
  onWorkflowAddressesRoutable: (addresses) => {
    // Assert rather than optional-chain so a wiring regression fails loud.
    if (sidecarDeployRouter === undefined) {
      throw new Error(
        "sidecar boot: deploy router was not constructed before a reconnect made workflow addresses routable",
      );
    }
    for (const address of addresses) {
      wrappedRepoStore.notifyAddressRoutable(address);
      // Re-registers parked correlations a long outage may have evicted from
      // the link's send queue; dedups hub-side on the correlationId constraint.
      sidecarDeployRouter.reEmitParkedCorrelations(address);
    }
  },
  // On disconnect, block the deployment addresses' workflow-run pushes until
  // the authenticated reconnect above re-routes them. Without the block, the
  // coalescing pusher re-ships onto the fresh, not-yet-registered connection
  // and the hub drops the frames as "unrouted".
  onWorkflowAddressesUnroutable: (addresses) => {
    for (const address of addresses) {
      wrappedRepoStore.markAddressUnroutable(address);
    }
  },
  createDeployRouter: ({
    sessions,
    keyStore,
    publishWorkflowInferenceEvent,
    publishWorkflowSuspension,
  }) => {
    const router = createSidecarDeployRouter({
      sessions,
      keyStore,
      senderKeyCache,
      transport,
      repoStore: wrappedRepoStore,
      signingKeySeed: sidecarSigningKey.privateKey,
      credentialCipher,
      createAgentCrypto: createEd25519Crypto,
      assertSourceBuildable: buildHarness.canBuildSource,
      registerDeployment: ({ runId, agentAddress }) => {
        deploymentAddressRegistry.record(runId, agentAddress);
      },
      unregisterDeployment: ({ runId }) => {
        deploymentAddressRegistry.unregister(runId);
      },
      multistepMailRouter,
      inboundMailPolicyRegistry,
      multistepSignalRouter,
      multistepDrainRouter,
      multistepGrantsRouter,
      multistepSourcesRouter,
      multistepCredentialsRouter,
      multistepSubstrateEnv,
      publishWorkflowInferenceEvent,
      publishWorkflowSuspension,
      ...(onDispatchTiming !== undefined ? { onDispatchTiming } : {}),
      ...(repackEveryMessages !== undefined ? { repackEveryMessages } : {}),
      ...(consumedRetentionMs !== undefined ? { consumedRetentionMs } : {}),
      ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
    });
    // Capture the router so the boot edge can drive its restore pass before
    // connecting. `createDeployRouter` runs synchronously during
    // `createSidecarOrchestrator` construction (exactly once, before the
    // handle returns), so `sidecarDeployRouter` is populated by the time the
    // restore call below runs.
    sidecarDeployRouter = router;
    return router;
  },
});

resolvedHubLink = orchestrator.hubLink;

// Re-establish the workflow deployments a prior sidecar process persisted,
// BEFORE opening the hub connection: each single-step head must have its
// mailbox/transport registration live before the hub can route to it.
// Assert the router was captured rather than optional-chaining it, so a
// future refactor that made `createDeployRouter` fire lazily would fail loud
// here instead of silently skipping restore.
if (sidecarDeployRouter === undefined) {
  throw new Error(
    "sidecar boot: deploy router was not constructed before workflow-deployment restore",
  );
}
await sidecarDeployRouter.restoreWorkflowRuns();

orchestrator.start();
