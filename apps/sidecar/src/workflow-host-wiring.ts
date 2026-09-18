// Thin wiring for createWorkflowSupervisor's sidecar-specific bindings; any
// logic reusable by a future alternative sidecar belongs in @intx/workflow-host, not here.

import { rm, stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

import { type } from "arktype";

import { derivePublicKeyBytes, signEd25519 } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type { HubTransport } from "@intx/mail-memory";
import {
  parseAgentId,
  workflowSourceAssetMountPath,
  type Principal,
  type RepoId,
  type RepoStore,
  type WorkflowRunSupervisorPrincipal,
} from "@intx/hub-sessions";
import {
  resolveInboundMailPolicy,
  type AgentKeyStore,
  type DeployRouter,
  type DeployRouterResult,
  type InboundMailPolicyRegistry,
  type SenderKeyCache,
  type SessionManager,
} from "@intx/hub-agent";
import {
  createWorkflowSupervisor,
  hashGrants,
  STEP_GRANTS_PATH,
  STEP_GRANTS_REF,
  wrapHubTransportAsMailBus,
  type CredentialsSnapshot,
  type CredentialsSnapshotStep,
  type DeriveStepAddress,
  type DeriveStepRepoId,
  type DispatchTimingMark,
  type FrameReader,
  type HubTransportMailBusAdapter,
  type NdjsonReader,
  type NdjsonWriter,
  type SpawnOpts,
  type SubprocessHandle,
  type SubprocessSpawner,
  type SuspensionRegistration,
  type WorkflowSupervisor,
} from "@intx/workflow-host";
import { hexDecode, hexEncode, type CredentialCipher, type SignalKind } from "@intx/types";
import {
  parseInferenceEvent,
  type ApprovalSnapshot,
  type CryptoProvider,
  type InferenceEvent,
  type InferenceSource,
  type KeyPair,
} from "@intx/types/runtime";
import {
  WorkflowProjectionDefinition,
  type AgentDeployFrame,
  type CredentialDelivery,
  type SourceRefPin,
} from "@intx/types/sidecar";
import { STEP_ID_PATTERN, projectLiveToInert } from "@intx/workflow";
import { deriveWorkflowRunRepoId, inertFlatNamespaceStepIds } from "@intx/workflow-deploy";

import { applyFrozenWorkflowClosure, type AppliedWorkflowClosure } from "./workflow-closure-apply";
import {
  MAX_INLINE_ASSET_PAYLOAD_BYTES,
  materializeWorkflowAssets,
  sourceAssetGitDir,
} from "./source-asset-delivery";
import { readRegistries } from "./sidecar-materialization-config";

import type {
  MultistepDrainRouter,
  MultistepGrantsRouter,
  MultistepMailRouter,
  MultistepSignalRouter,
  MultistepSourcesRouter,
  MultistepCredentialsRouter,
} from "./workflow-run-pack-client";
import {
  deleteWorkflowRunRecord,
  scanWorkflowRunRecords,
  writeWorkflowRunRecord,
  type WorkflowRunRecord,
} from "./workflow-run-record";
import { readRunGrants, runGrantsPath } from "./run-grants";

const logger = getLogger(["interchange", "sidecar", "workflow-host-wiring"]);

// A raw Ed25519 public key is 32 bytes.
const ED25519_PUBLIC_KEY_BYTES = 32;

/** Thin delegator to `@intx/workflow-deploy` so the hub's read routes reconstruct the identical id; named for the deploy-phase routing slug, not a run identity. */
export function deriveDeploymentId(agentAddress: string): string {
  return deriveWorkflowRunRepoId(agentAddress);
}

/** A sibling of the closure instance dir, never reclaimed by apply/restore, so checked-out assets survive a restart. */
function deploymentSourceAssetRoot(dataDir: string, deploymentId: string): string {
  return pathJoin(dataDir, "workflow-definition-sources", deploymentId);
}

/**
 * The durable indexed-`.git` store root a pinned deployment's source-format
 * asset entries are checked out from. Sibling of the plain-file source store;
 * both survive restart so re-materialization needs no re-delivery.
 */
function deploymentSourceGitRoot(dataDir: string, deploymentId: string): string {
  return pathJoin(dataDir, "workflow-definition-source-gits", deploymentId);
}

/**
 * The `assetId -> mountPath` map a pinned closure's TARBALL `kind:"asset"`
 * entries resolve against, derived purely from the pin (via the shared
 * mount-path helper) so deploy and restore agree without the frame's delivered
 * assets. Source-format entries resolve through `deriveSourceGitDirs` instead.
 */
function deriveSourceAssetMounts(pin: SourceRefPin): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const entry of pin.closure.entries) {
    if (entry.source.kind === "asset" && entry.source.package.format === "tarball") {
      mounts.set(entry.source.assetId, workflowSourceAssetMountPath(entry.source.assetId));
    }
  }
  return mounts;
}

/**
 * The `assetId -> gitDir` map a pinned closure's SOURCE `kind:"asset"` entries
 * check subtrees out of, derived purely from the pin so deploy and restore
 * agree without re-delivery.
 */
function deriveSourceGitDirs(pin: SourceRefPin, gitRoot: string): Map<string, string> {
  const gitDirs = new Map<string, string>();
  for (const entry of pin.closure.entries) {
    if (entry.source.kind === "asset" && entry.source.package.format === "source") {
      gitDirs.set(entry.source.assetId, sourceAssetGitDir(gitRoot, entry.source.assetId));
    }
  }
  return gitDirs;
}

async function isExistingDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/** Cheap early gate for a missing checkout (the loader still SRI-verifies bytes); a missing mount fails loud since the hub must re-drive it. */
export async function resolveDeploymentAssetMounts(
  dataDir: string,
  deploymentId: string,
  pin: SourceRefPin,
): Promise<{
  assetRoot: string;
  assetMounts: ReadonlyMap<string, string>;
  gitDirs: ReadonlyMap<string, string>;
}> {
  const assetRoot = deploymentSourceAssetRoot(dataDir, deploymentId);
  const assetMounts = deriveSourceAssetMounts(pin);
  for (const [assetId, mountPath] of assetMounts) {
    const mountDir = pathJoin(assetRoot, mountPath);
    if (!(await isExistingDir(mountDir))) {
      throw new Error(
        `resolveDeploymentAssetMounts: source asset ${JSON.stringify(assetId)} for deployment ${deploymentId} is not present in the durable store at ${mountDir}; the deployment must be re-driven from the hub`,
      );
    }
  }
  const gitRoot = deploymentSourceGitRoot(dataDir, deploymentId);
  const gitDirs = deriveSourceGitDirs(pin, gitRoot);
  for (const [assetId, gitDir] of gitDirs) {
    if (!(await isExistingDir(gitDir))) {
      throw new Error(
        `resolveDeploymentAssetMounts: source asset ${JSON.stringify(assetId)} for deployment ${deploymentId} has no indexed git store at ${gitDir}; the deployment must be re-driven from the hub`,
      );
    }
  }
  return { assetRoot, assetMounts, gitDirs };
}

/** A missing or non-numeric byte cap is a boot-edge wiring bug, so it fails loud rather than defaulting. */
function requireSubstrateByteCap(env: Record<string, string>, key: string): number {
  const raw = env[key];
  if (raw === undefined) {
    throw new Error(
      `sidecar deploy router: ${key} must be present in the multi-step substrate env to materialize a frozen workflow closure`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `sidecar deploy router: ${key} must be a positive finite number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/** The deploy router is the local stand-in for the hub on the sidecar's disk, so it claims the hub principal for this write since agent-state gates writeTree as hub-only. */
const GRANTS_WRITE_PRINCIPAL: Principal = { kind: "hub" };

/** Single-step and multi-step deploys disagree on how the address/repo id are computed, so the two derivations are minted together to stay in sync. */
type StepStrategy = {
  deriveStepAddress: DeriveStepAddress;
  deriveStepRepoId: DeriveStepRepoId;
};

/**
 * A single-step deploy keeps the deploy's own mail address; any other step
 * count derives a `<runId>-<stepId>` address/repo per step. Note this does
 * NOT feed step-agent-tools.ts's stepDeployTreeDir, which re-derives the
 * step address independently — the deploy tree must still be staged there.
 */
function createStepStrategy(args: {
  legacyAddress: string;
  stepOrder: readonly string[];
  multistepDeriveStepAddress: DeriveStepAddress;
}): StepStrategy {
  if (args.stepOrder.length === 1) {
    return {
      deriveStepAddress: () => args.legacyAddress,
      // Deferred into the closure so a malformed address surfaces at the same point the rest of spawn() would fault.
      deriveStepRepoId: () => ({
        kind: "agent-state",
        id: parseAgentId(args.legacyAddress),
      }),
    };
  }
  return {
    deriveStepAddress: args.multistepDeriveStepAddress,
    deriveStepRepoId: ({ runId, stepId }) => ({
      kind: "agent-state",
      id: `${runId}-${stepId}`,
    }),
  };
}

/**
 * Two destinations selected by `runId`: absent means deploy time (writes
 * every step's grants into its own agent-state repo, on the spawn critical
 * path so a failure rejects the deploy); present means per-run delivery
 * (writes one `runs/<runId>/grants.json`, ignoring stepOrder/deriveStepRepoId).
 */
async function writeStepGrants(args: {
  repoStore: RepoStore;
  anchorRunId: string;
  stepOrder: readonly string[];
  deriveStepRepoId: DeriveStepRepoId;
  grants: readonly unknown[] | undefined;
  runId?: string;
}): Promise<void> {
  // The deploy frame's validated HarnessConfig always carries a `grants`
  // array (possibly empty); an absent array means "no grants", which
  // serializes to the same fail-closed empty file the snapshot expects.
  // Coerce here so the on-disk envelope is always a valid `{ grants: [] }`
  // rather than `{}` (which the snapshot's validator rejects).
  const grants = args.grants ?? [];
  const serialized = JSON.stringify({ grants }, null, 2);
  if (args.runId !== undefined) {
    await args.repoStore.writeTree(
      GRANTS_WRITE_PRINCIPAL,
      { kind: "workflow-run", id: args.anchorRunId },
      STEP_GRANTS_REF,
      {
        files: { [runGrantsPath(args.runId)]: serialized },
        message: `Write run grants for ${args.runId}`,
      },
    );
    return;
  }
  for (const stepId of args.stepOrder) {
    const repoId = args.deriveStepRepoId({
      runId: args.anchorRunId,
      stepId,
    });
    await args.repoStore.writeTree(GRANTS_WRITE_PRINCIPAL, repoId, STEP_GRANTS_REF, {
      files: { [STEP_GRANTS_PATH]: serialized },
      message: `Write step grants for ${stepId}`,
    });
  }
}

export type AssembleRunCredentialsSnapshotOpts = {
  /** Substrate handle the sink reads the per-run grants file from. */
  repoStore: RepoStore;
  /** Anchor run id keying the workflow-run repo the grants file lives in. */
  anchorRunId: string;
  /** Run whose per-run grants file is read. */
  runId: string;
  /**
   * Every step id the snapshot must cover -- the deployment's flat step-id
   * namespace, loop-body step ids included. The per-run grants apply
   * uniformly across them.
   */
  stepOrder: readonly string[];
  /** Per-step mail-address derivation. */
  deriveStepAddress: DeriveStepAddress;
};

/**
 * Every legitimate run birth path writes `runs/<runId>/grants.json` before
 * the run dispatches, so a missing file means the run reached its barrier
 * with no grants written; this fails closed rather than running
 * under-authorized. A malformed file also throws for the same reason.
 */
export async function assembleRunCredentialsSnapshot(
  opts: AssembleRunCredentialsSnapshotOpts,
): Promise<CredentialsSnapshot> {
  const runGrants = await readRunGrants({
    repoStore: opts.repoStore,
    anchorRunId: opts.anchorRunId,
    runId: opts.runId,
  });
  if (runGrants === undefined) {
    throw new Error(
      `sidecar onRunStart: run ${opts.runId} has no grants file at ${runGrantsPath(opts.runId)}; refusing to start the run under-authorized`,
    );
  }
  const contentHash = await hashGrants(runGrants);
  const steps: CredentialsSnapshotStep[] = opts.stepOrder.map((stepId) => ({
    stepId,
    address: opts.deriveStepAddress({
      runId: opts.anchorRunId,
      stepId,
    }),
    grants: runGrants,
    contentHash,
  }));
  return { steps };
}

// Resolved statically at module load so the production spawn surface is
// independent of any runtime env override; tests inject a sentinel path
// via the binaryPath opts override instead.
const SIDECAR_WORKFLOW_CHILD_BINARY: string = (() => {
  const url = import.meta.resolve("../bin/workflow-child");
  return fileURLToPath(url);
})();

/** fd 0/1 are the control channel, fd 2 is inherited stderr, fd 3 is the event-channel pipe Bun.spawn's stdio[3]="pipe" provisions. */
const CHILD_EVENT_CHANNEL_FD = 3;

/** Passes each already-newline-terminated frame through without buffering, so it surfaces as soon as write() resolves. */
function ndjsonWriterFromFileSink(sink: Bun.FileSink): NdjsonWriter {
  return {
    async write(line: string): Promise<void> {
      const result = sink.write(line);
      if (typeof result !== "number") await result;
      const flushed = sink.flush();
      if (typeof flushed !== "number") await flushed;
    },
  };
}

/**
 * Wrap a Bun stdout `ReadableStream` as the supervisor's
 * `NdjsonReader`. The pipe is a byte stream; this reader buffers
 * partial chunks and yields one complete line per iteration. The
 * receiver's iterator finalises only on EOF, which mirrors the
 * `defaultControlReader` shape the child wires for `process.stdin`.
 */
function ndjsonReaderFromReadableStream(stream: ReadableStream<Uint8Array>): NdjsonReader {
  return {
    read(): AsyncIterableIterator<string> {
      return (async function* () {
        const decoder = new TextDecoder("utf-8");
        let pending = "";
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value !== undefined) {
              pending += decoder.decode(value, { stream: true });
              let nl = pending.indexOf("\n");
              while (nl >= 0) {
                const line = pending.slice(0, nl).replace(/\r$/, "");
                pending = pending.slice(nl + 1);
                if (line.length > 0) yield line;
                nl = pending.indexOf("\n");
              }
            }
            if (done) break;
          }
          if (pending.length > 0) yield pending;
        } finally {
          reader.releaseLock();
        }
      })();
    },
  };
}

/** Yields each raw chunk the kernel delivers and trusts one-write-per-envelope; framing discipline lives in receiveEventChannel's parser. */
function frameReaderFromFd(fd: number): FrameReader {
  const stream = Bun.file(fd).stream();
  return {
    read(): AsyncIterableIterator<Uint8Array> {
      return (async function* () {
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value !== undefined && value.byteLength > 0) yield value;
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      })();
    },
  };
}

/**
 * Constructs a fresh env with no inheritance of the sidecar's process env.
 * A launch failure settles `exited` non-zero; the supervisor races that
 * against `readyPromise` so a spawn-time crash rejects rather than wedging.
 */
export const defaultSubprocessSpawner: SubprocessSpawner = ({
  binaryPath,
  env,
}): SubprocessHandle => {
  const proc = Bun.spawn([binaryPath], {
    stdio: ["pipe", "pipe", "inherit", "pipe"],
    env,
  });
  const eventFd = proc.stdio[CHILD_EVENT_CHANNEL_FD];
  if (typeof eventFd !== "number") {
    throw new Error(
      `workflow-host-wiring: Bun.spawn did not return a numeric fd at stdio[${String(CHILD_EVENT_CHANNEL_FD)}] for the event channel; got ${typeof eventFd}`,
    );
  }
  return {
    pid: proc.pid,
    controlWriter: ndjsonWriterFromFileSink(proc.stdin),
    controlReader: ndjsonReaderFromReadableStream(proc.stdout),
    eventReader: frameReaderFromFd(eventFd),
    kill(signal?: number | string): void {
      // Bun's kill() takes NodeJS.Signals, narrower than the supervisor's number|string; cast at the boundary.
      if (signal === undefined) {
        proc.kill();
        return;
      }
      if (typeof signal === "number") {
        proc.kill(signal);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- supervisor's kill widens to `string`; Bun's runtime accepts the same `"SIG*"` strings, narrowed back at the boundary.
      proc.kill(signal as NodeJS.Signals);
    },
    exited: proc.exited,
  };
};

export type CreateSidecarWorkflowSupervisorOpts = {
  /** Sidecar's hub mail transport. */
  transport: HubTransport;
  /** Substrate-shaped RepoStore the workflow-host's supervisor reads from. */
  repoStore: RepoStore;
  /** Sidecar's 32-byte Ed25519 private key seed for principal signing. */
  signingKeySeed: Uint8Array;
  /** Workflow-run repo identity for the deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run repo ref the supervisor commits events to. */
  workflowRunRef: string;
  /** Deployment id baked into principal claims and address derivation. */
  runId: string;
  /** Decrypted credential material delivered to the child on the pre-trigger barrier; absent when the deployment binds no credentials. */
  credentialDelivery?: CredentialDelivery;
  /** Threaded into the child's spawn-time env so its deploy-tree read collapses onto the head for a single-step deployment. */
  stepCount: number;
  /** Every step id (including loop-body ids) the onRunStart grants sink walks to assemble the per-run credentialsSnapshot. */
  stepOrder: readonly string[];
  /** Deployment's mail address. */
  deploymentMailAddress: string;
  /** Per-step mail-address derivation. */
  deriveStepAddress: DeriveStepAddress;
  /** Overrides the default `<runId>-<stepId>` repo id; single-step deploy returns the legacy agent-state repo instead. */
  deriveStepRepoId?: DeriveStepRepoId;
  /** Substrate-config keys propagated to the child via spawn-time env. */
  substrateEnv: Record<string, string>;
  /** Recomputed on every spawn and recycle respawn (e.g. a live-rotated inference-source list); layers over substrateEnv. */
  dynamicSpawnEnv: () => Record<string, string>;
  /** Tests inject a deterministic mock; production defaults to defaultSubprocessSpawner. */
  subprocessSpawner?: SubprocessSpawner;
  /** Override the `bin/workflow-child` path. */
  binaryPath?: string;
  /** Absent in production; the deploy router wires this (off a benchmark env gate) only for the Phase 4.7 latency gate. */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /** Absent in production; the deploy router wires this (off the same benchmark env gate) only for the D2 attribution run. */
  repackEveryMessages?: { everyMessages: number };
  /** Boot edge resolves the operator's CONSUMED_RETENTION_MS; absent, the supervisor applies its own 24h default. */
  consumedRetentionMs?: number;
  /** Boot edge resolves the operator's CHILD_READY_TIMEOUT_MS; absent, the supervisor applies its own 30s default. */
  readyTimeoutMs?: number;
  /** Invoked when a child reports park.notify; production wiring routes it to the hub link's signal.correlation.register. */
  onSuspensionRegister?: (registration: SuspensionRegistration) => void;
  /** Invoked on a terminal phase (crash-loop, channel crash, recycle failure); production routes it to the deploy router's address reclaim. */
  onSelfTerminate?: (info: { phase: "stopped" | "crash-looping"; reason: string }) => void;
  /** Lets a run whose grants write is KNOWN to have failed reject with that specific reason instead of a generic missing-file error. */
  isRunPoisoned?: (runId: string) => boolean;
};

export type SidecarWorkflowSupervisor = {
  supervisor: WorkflowSupervisor;
  /** Resolves once durably accepted (so the hub-link can send mail.inbound.ack only then) and rejects otherwise. */
  routeInbound(message: Uint8Array): Promise<void>;
  /** Snapshot accessor that proxies the supervisor's credentials view. */
  getCredentialsSnapshot(): CredentialsSnapshot | null;
  /** The per-run grants barrier; rejects for a poisoned run, exposed so it can be exercised without driving a full spawn. */
  onRunStart(args: { runId: string; anchorRunId: string }): Promise<CredentialsSnapshot>;
};

/** Listed here so the router and the substrate-factory consumer spell this env key the same way without a magic-string trip hazard. */
export const STEP_INFERENCE_SOURCES_ENV_KEY = "STEP_INFERENCE_SOURCES";

/** Carries every spawned body's per-step inference-source pins as plaintext JSON so the child resolves them without the sidecar's cipher key. */
export const WORKFLOW_BODY_SOURCES_ENV_KEY = "WORKFLOW_BODY_SOURCES";

/** Below the OS argument-string ceiling (128 KiB on Linux) with headroom, so an over-large deployment is rejected loudly at deploy time, not at a much-later spawn's execve. */
const WORKFLOW_BODY_SOURCES_MAX_BYTES = 96 * 1024;

/** `undefined` when the deployment references no bodies, so the record omits the field. */
function buildBodySourcesMap(
  referenced: NonNullable<AgentDeployFrame["workflow"]>["referencedDefinitions"],
): WorkflowRunRecord["bodySources"] {
  if (referenced === undefined || referenced.length === 0) {
    return undefined;
  }
  const map: NonNullable<WorkflowRunRecord["bodySources"]> = {};
  for (const ref of referenced) {
    map[ref.definition.id] = ref.sources;
  }
  return map;
}

/** Takes `unknown` inputs (unlike the arktype AgentDeployFrame validator) so it can also gate callers that bypass the wire boundary. */
export function validateWorkflowProjection(projection: {
  definition: { id: unknown; stepOrder: unknown; steps: unknown };
  sources: unknown;
}): void {
  const def = projection.definition;
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error("sidecar deploy router: workflow.definition.id must be a non-empty string");
  }
  if (!Array.isArray(def.stepOrder) || def.stepOrder.length === 0) {
    throw new Error(
      "sidecar deploy router: workflow.definition.stepOrder must be a non-empty array",
    );
  }
  if (typeof def.steps !== "object" || def.steps === null) {
    throw new Error("sidecar deploy router: workflow.definition.steps must be an object");
  }
  if (typeof projection.sources !== "object" || projection.sources === null) {
    throw new Error("sidecar deploy router: workflow.sources must be an object");
  }
  const steps = def.steps;
  const sources = projection.sources;
  for (const stepId of def.stepOrder) {
    if (typeof stepId !== "string" || stepId.length === 0) {
      throw new Error(
        "sidecar deploy router: workflow.definition.stepOrder entries must be non-empty strings",
      );
    }
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new Error(
        `sidecar deploy router: stepId ${JSON.stringify(stepId)} must match ${STEP_ID_PATTERN.source}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(steps, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.definition.steps is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(sources, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.sources is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sources is checked to be a non-null object above; this reads a value to re-check its array shape
    const stepSources = (sources as Record<string, unknown>)[stepId];
    if (!Array.isArray(stepSources) || stepSources.length === 0) {
      throw new Error(
        `sidecar deploy router: workflow.sources[${JSON.stringify(stepId)}] must be a non-empty array (the step's ordered inference-source failover chain)`,
      );
    }
  }
}

/** The supervisor signs every workflow-run event with this key; the multi-step branch surfaces it so the hub records the verifying key. */
async function derivePrincipalPublicKeyHex(signingKeySeed: Uint8Array): Promise<string> {
  return hexEncode(await derivePublicKeyBytes(signingKeySeed));
}

/** Adds the sidecar-app-only boot-time restore driver on top of the shared `DeployRouter` contract. */
export interface SidecarDeployRouter extends DeployRouter {
  /** Soft-fails per deployment (a record left on disk for a later boot to retry, never deleted) rather than failing the whole boot. */
  restoreWorkflowRuns(): Promise<void>;
  /** Addresses this router currently hosts a live supervisor for; re-read per connect since deploy/undeploy/restore change it live. */
  activeAddresses(): string[];
  /** Re-registers parked correlations a long outage may have evicted from the hub's bounded send queue; fire-and-forget. */
  reEmitParkedCorrelations(address: string): void;
}

export function createSidecarDeployRouter(deps: {
  sessions: SessionManager;
  keyStore: AgentKeyStore;
  /** Grants handler writes each co-delivered senderIdentities entry here before the run's grants land, so a durable grant always has its verify key. */
  senderKeyCache: SenderKeyCache;
  transport: HubTransport;
  repoStore: RepoStore;
  signingKeySeed: Uint8Array;
  /** Seals each run record's inference-source apiKeys on persist and unseals them on the boot scan. */
  credentialCipher: CredentialCipher;
  /** Registers the spawned agent's signing key on the transport before spawn(), or an outbound send throws "address is not registered". */
  createAgentCrypto: (keyPair: KeyPair) => CryptoProvider;
  /** Distinct from the operator-approval check: this gates on whether a provider is buildable at all, not whether it was approved. */
  assertSourceBuildable: (source: InferenceSource) => void;
  /** Fires once per inbound agent.deploy before the supervisor spawns, so the first pack push sees the mapping. No-op-safe for tests. */
  registerDeployment: (entry: { runId: string; agentAddress: string }) => void;
  /** Symmetric removal hook so a stale writeTreePreservingPrefix fails structurally instead of resolving to the prior address. */
  unregisterDeployment: (entry: { runId: string; agentAddress: string }) => void;
  /** Defaults to empty so a router built without substrate config (e.g. a test) needs no boot-edge threading. */
  multistepSubstrateEnv?: Record<string, string>;
  /** Defaults to the production Bun.spawn-backed spawner; tests inject a deterministic mock. */
  multistepSubprocessSpawner?: SubprocessSpawner;
  /** Production wiring uses the package-local default; tests inject a sentinel value the mock spawner can assert on. */
  multistepBinaryPath?: string;
  /** Session id rides alongside the (sessionless) InferenceEvent since it's optional for a headless deployment; defaults to a no-op. */
  publishWorkflowInferenceEvent?: (
    agentAddress: string,
    event: InferenceEvent,
    sessionId: string | undefined,
  ) => void;
  /** Registers a parked run's correlation at the hub; defaults to a no-op. */
  publishWorkflowSuspension?: (registration: {
    correlationId: string;
    runId: string;
    anchorRunId: string;
    agentAddress: string;
    kind: SignalKind;
    approvalSnapshot?: ApprovalSnapshot;
  }) => void;
  /** Defaults to `${runId}-${stepId}@<deploymentDomain>`; tests inject a deterministic factory. */
  multistepDeriveStepAddress?: DeriveStepAddress;
  /** Registers wired.routeInbound once spawn succeeds; absent means multi-step inbound mail cannot route until wired. */
  multistepMailRouter?: MultistepMailRouter;
  /** Removed in the same teardown as the mail-router registration so a reused address never inherits a stale policy; absent means fully-closed default. */
  inboundMailPolicyRegistry?: InboundMailPolicyRegistry;
  /** The child commits the resulting SignalReceived through its own substrate, preserving the single-writer invariant sidecar-side. */
  multistepSignalRouter?: MultistepSignalRouter;
  /** Cancel-mode in-flight steps abort child-side; wait-mode steps continue until the drainTimeout deadline commits a CancelRequested. */
  multistepDrainRouter?: MultistepDrainRouter;
  /** The write is awaited in tryRoute so the frame's FIFO completion means grants are durable on disk. */
  multistepGrantsRouter?: MultistepGrantsRouter;
  /** Only a single-step warm deployment registers a handler; a multi-step deployment has no warm agent to rotate, so its address is unrouted. */
  multistepSourcesRouter?: MultistepSourcesRouter;
  /** Every deployment with a supervisor registers one after spawn (material cell is per-child); an unregistered address is unrouted. */
  multistepCredentialsRouter?: MultistepCredentialsRouter;
  /** Resolved from the Phase 4.7 latency-gate env; absent in ordinary production. */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /** Resolved from the same benchmark env gate; absent in ordinary production. */
  repackEveryMessages?: { everyMessages: number };
  /** Boot edge resolves the operator's CONSUMED_RETENTION_MS; absent, the supervisor applies its own 24h default. */
  consumedRetentionMs?: number;
  /** A child that spawns but never signals ready is killed and its spawn rejected rather than hanging the deploy or restore. */
  readyTimeoutMs?: number;
  /**
   * Run-record writer, injectable so a test can block or fail the
   * persist at a controlled point -- the natural seam for exercising a
   * recycle that interleaves the source-rotation persist window. Defaults
   * to the real `writeWorkflowRunRecord`; production never overrides
   * it.
   */
  writeWorkflowRunRecord?: typeof writeWorkflowRunRecord;
  /**
   * Materialize a source-ref deployment's frozen closure. Defaults to the real
   * `applyFrozenWorkflowClosure` (registry fetch + SRI verify + layout);
   * production never overrides it. A test seam so a unit test can drive the
   * deploy/restore source-ref path without a live registry.
   */
  applyFrozenWorkflowClosure?: typeof applyFrozenWorkflowClosure;
}): SidecarDeployRouter {
  // Validate the signing seed at construction so a malformed key fails
  // sidecar boot rather than the first multi-step deploy, where the
  // public key is derived from it (`derivePrincipalPublicKeyHex`). The
  // seed also signs every workflow-run event via the supervisor.
  if (deps.signingKeySeed.length !== 32) {
    throw new Error(
      `sidecar deploy router: Ed25519 signing seed must be 32 bytes, got ${deps.signingKeySeed.length}`,
    );
  }
  const publishInferenceEvent =
    deps.publishWorkflowInferenceEvent ??
    ((_address: string, _event: InferenceEvent, _sessionId: string | undefined): void => {
      /* no-op default: tests and production-without-a-publisher
         deployments do not consume events. */
    });
  const publishSuspension =
    deps.publishWorkflowSuspension ??
    ((_registration: {
      correlationId: string;
      runId: string;
      anchorRunId: string;
      agentAddress: string;
      kind: SignalKind;
      approvalSnapshot?: ApprovalSnapshot;
    }): void => {
      /* no-op default: tests and production-without-a-publisher
         deployments do not register suspensions. */
    });
  const multistepSubstrateEnv = deps.multistepSubstrateEnv ?? {};
  // Sidecar data dir the deployment's per-step scratch is rooted under
  // (`<dataDir>/workflow-step-state/<runId>/...`). Resolved once
  // from the boot-edge substrate env so the undeploy hook can reclaim
  // the whole subtree. Absent only when the router is wired without
  // substrate config (a test that never spawns a child), in which case
  // no child ever rooted scratch and the undeploy reclaim is correctly
  // skipped.
  const stepStateDataDir = multistepSubstrateEnv.SIDECAR_DATA_DIR;
  const persistWorkflowRunRecord = deps.writeWorkflowRunRecord ?? writeWorkflowRunRecord;
  const applyClosure = deps.applyFrozenWorkflowClosure ?? applyFrozenWorkflowClosure;
  const multistepSpawner = deps.multistepSubprocessSpawner ?? defaultSubprocessSpawner;
  const multistepDeriveStepAddress: DeriveStepAddress =
    deps.multistepDeriveStepAddress ?? (({ runId, stepId }) => `${runId}-${stepId}`);

  // Per-deployment supervisor tracking. The multi-step branch
  // constructs one `SidecarWorkflowSupervisor` per `agent.deploy`
  // frame; the supervisor owns the workflow-process child, its IPC
  // pipes, and its event-channel fd. The undeploy hook consults this
  // map to call `supervisor.shutdown()` so the child's lifetime ends
  // with the deployment.
  const activeSupervisors = new Map<string, SidecarWorkflowSupervisor>();

  // Closes the window before activeSupervisors is populated (only after spawn
  // succeeds): a second same-address frame arriving mid-deploy is rejected
  // here rather than deleting the winner's live run record on unwind.
  const reservingDeployAddresses = new Set<string>();

  // deriveDeploymentId's char substitution is lossy: two distinct addresses
  // can collapse to the same slug, which IS the repoId, so a collision would
  // let the second deploy silently overwrite the first's repo state.
  const slugClaims = new Map<string, string>();

  function claimSlug(runId: string, agentAddress: string): void {
    const existing = slugClaims.get(runId);
    if (existing !== undefined && existing !== agentAddress) {
      throw new Error(
        `deriveDeploymentId collision: run addresses ${JSON.stringify(existing)} and ${JSON.stringify(agentAddress)} both project to runId ${JSON.stringify(runId)}`,
      );
    }
    // Defensive no-op: activeSupervisors already rejects a live re-deploy, so existing is only ever undefined or a different address here.
    slugClaims.set(runId, agentAddress);
  }

  function releaseSlug(runId: string, agentAddress: string): void {
    const existing = slugClaims.get(runId);
    if (existing === agentAddress) slugClaims.delete(runId);
  }

  // Reclaims an address whose supervisor drove ITSELF to a terminal phase
  // without an operator undeploy. Never deletes the durable run record (so a
  // boot restore can re-spawn) and never calls unregisterDeployment (the
  // pack-push mapping is still needed by the crash-loop latch's own commit).
  function reclaimSelfTerminatedSupervisor(args: { runId: string; agentAddress: string }): void {
    if (!activeSupervisors.has(args.agentAddress)) return;
    // Drop racing frames at the router boundary first, then unwind the
    // underlying registrations -- the same ordering the undeploy hook uses.
    deps.multistepMailRouter?.unregister(args.agentAddress);
    deps.inboundMailPolicyRegistry?.unregister(args.agentAddress);
    deps.multistepSignalRouter?.unregister(args.agentAddress);
    deps.multistepDrainRouter?.unregister(args.agentAddress);
    deps.multistepGrantsRouter?.unregister(args.agentAddress);
    deps.multistepSourcesRouter?.unregister(args.agentAddress);
    deps.multistepCredentialsRouter?.unregister(args.agentAddress);
    activeSupervisors.delete(args.agentAddress);
    deps.transport.unregister(args.agentAddress);
    releaseSlug(args.runId, args.agentAddress);
  }

  /** Reclaims a pre-sealed-record deploy's legacy plaintext body-source staging, now retired since sources ride sealed in the run record. */
  async function sweepLegacyBodySources(
    sidecarDataDir: string | undefined,
    definitionId: string,
  ): Promise<void> {
    if (typeof sidecarDataDir !== "string" || sidecarDataDir.length === 0) {
      throw new Error(
        "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the legacy body-source staging is reclaimed against this data dir",
      );
    }
    const bodyAssetDir = pathJoin(sidecarDataDir, "assets", "workflow", definitionId);
    await rm(bodyAssetDir, { recursive: true, force: true });
  }

  /**
   * The per-deployment inputs the shared spawn core needs to stand up a
   * workflow deployment, independent of the live deploy frame. The live
   * deploy path builds this from `frame`/`projection`; a boot-time restore
   * path builds the same shape from the persisted run record.
   */
  interface WorkflowDeploySpec {
    agentAddress: string;
    /** Always the closure evaluation (source-ref is the only deploy lineage), never a frame-carried inline definition. */
    definition: WorkflowProjectionDefinition;
    sources: NonNullable<AgentDeployFrame["workflow"]>["sources"];
    /** Delivered to the run child as plaintext through the spawn env so it resolves sources without the sidecar's cipher key. */
    bodySources: WorkflowRunRecord["bodySources"];
    /** Delivered to the child on the pre-trigger barrier; undefined when the deployment binds no credentials. */
    credentials: CredentialDelivery | undefined;
    /** Sourced from hub authority, never a sidecar recompute; undefined only for a frame that carried no approved hash. */
    approvedWireHash: string | undefined;
    /** Correlates the child's inference events to the deploy's session. */
    sessionId: string | undefined;
    /** Required for a single-step deployment (head IS the agent identity); undefined for multi-step, which derives per-step addresses. */
    hubPublicKey: string | undefined;
    /** Sidecar-local only: never travels on the hub deploy frame and isn't persisted to the record. Always present. */
    closurePackageDir: string;
    /** Carried so a boot-time restore can re-run applyFrozenWorkflowClosure; its source carries no secret, its closure is versions + SRIs. */
    sourceRef: NonNullable<AgentDeployFrame["workflow"]>["sourceRef"];
  }

  /** Table is a parameter (not spec.sources) so both the deploy path and the rotation handler write through one shape. */
  function buildWorkflowRunRecord(
    spec: WorkflowDeploySpec,
    sources: WorkflowRunRecord["sources"],
  ): WorkflowRunRecord {
    // A spec missing this is a wiring defect; fail loudly rather than persist a record the boot scan would reject as corrupt.
    if (spec.approvedWireHash === undefined) {
      throw new Error(
        `buildWorkflowRunRecord: a source-ref deployment (${spec.agentAddress}) must carry approvedWireHash`,
      );
    }
    return {
      version: 2 as const,
      agentAddress: spec.agentAddress,
      definitionId: spec.definition.id,
      sources,
      ...(spec.bodySources !== undefined ? { bodySources: spec.bodySources } : {}),
      ...(spec.credentials !== undefined ? { credentials: spec.credentials } : {}),
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      ...(spec.hubPublicKey !== undefined ? { hubPublicKey: spec.hubPublicKey } : {}),
      lineage: "source-ref",
      // Feeds the restored child's DEFINITION_HASH so it re-verifies the
      // evaluated closure against the hub-approved pin, and the source-ref pin a
      // restore re-runs applyFrozenWorkflowClosure with.
      approvedWireHash: spec.approvedWireHash,
      sourceRef: spec.sourceRef,
    };
  }

  /**
   * Shared plumbing for both the deploy path and boot-time restore. The
   * instance dir is force-reclaimed before the apply since deploymentId is
   * deterministic per address and a prior soft-failed deploy can leave it
   * half-materialized; safe only because no live reader holds the dir when
   * this runs, a precondition each caller establishes at its call site.
   */
  async function materializeDeploymentClosure(
    dataDir: string,
    deploymentId: string,
    pin: SourceRefPin,
  ): Promise<AppliedWorkflowClosure> {
    const instanceDir = pathJoin(dataDir, "workflow-definition-closures", deploymentId);
    await rm(instanceDir, { recursive: true, force: true });

    // Tarball `kind:"asset"` entries read from the durable plain-file store; a
    // source-format entry checks its subtree out of the durable indexed git
    // store. Deriving and asserting both from the pin alone is what makes this
    // symmetric on deploy and restore.
    const { assetRoot, assetMounts, gitDirs } = await resolveDeploymentAssetMounts(
      dataDir,
      deploymentId,
      pin,
    );

    return applyClosure({
      source: pin.source,
      closure: pin.closure,
      instanceDir,
      cacheRoot: pathJoin(dataDir, "workflow-definition-closure-cache"),
      cacheMaxBytes: requireSubstrateByteCap(multistepSubstrateEnv, "SIDECAR_CACHE_MAX_BYTES"),
      registryMaxTarballBytes: requireSubstrateByteCap(
        multistepSubstrateEnv,
        "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
      ),
      registries: readRegistries(),
      assetRoot,
      assetMounts,
      gitDirs,
    });
  }

  /**
   * The single owner of the workflow-deployment spawn sequence; its
   * try/finally unwinds every piece of partial state if any step throws.
   * Both the live deploy path and the boot-time restore path route through
   * here so the two can never diverge on how a deployment is stood up.
   */
  async function spawnWorkflowRun(spec: WorkflowDeploySpec): Promise<DeployRouterResult> {
    // Sealed into the record by the sidecar's cipher; restore unseals it from the record.
    const credentialDelivery = spec.credentials;
    // The primary early guard, ahead of the lower-level transport.register duplicate-throw backstop; guards against a boot restore racing a legacy restore for the same address.
    if (activeSupervisors.has(spec.agentAddress)) {
      throw new Error(
        `sidecar deploy router: a supervisor is already active for ${spec.agentAddress}; refusing to spawn a second`,
      );
    }
    const runId = deriveDeploymentId(spec.agentAddress);

    const stepStrategy = createStepStrategy({
      legacyAddress: spec.agentAddress,
      stepOrder: spec.definition.stepOrder,
      multistepDeriveStepAddress,
    });

    // Not stepOrder: a loop body runs in-process inheriting the parent's env, so it must authorize against the same snapshot keyed by its own plain step id.
    const credentialStepIds = inertFlatNamespaceStepIds({
      definition: spec.definition,
      context: "sidecar deploy router credentials snapshot: ",
    });

    // The caller owns the deployment slug and the deployment-address registration, so neither is touched in this unwind.
    let succeeded = false;
    let wiredForUnwind: SidecarWorkflowSupervisor | undefined;
    let supervisorRegistered = false;
    let routersRegistered = false;
    let agentTransportRegistered = false;
    let hubKeyRecorded = false;
    let deploymentRegistered = false;
    try {
      // A missing hash is a wiring bug, not a legacy case: substituting a sidecar recompute would collapse the child's re-verify to a self-check against its own hash.
      if (spec.approvedWireHash === undefined) {
        throw new Error(
          `workflow deploy spawn (${spec.agentAddress}): the deploy spec carries no approvedWireHash. The hub deploy builder must stamp the hub-approved wire hash and a restore must re-attach it from the persisted record; the sidecar will not recompute it, which would collapse the child's re-verify to a self-check.`,
        );
      }
      const definitionHash = spec.approvedWireHash;

      // Bodies don't live-rotate, unlike top-level sources; guarded against the OS argument-string ceiling here so an over-large deployment fails at deploy, not at a later child execve.
      const bodySourcesEnv = JSON.stringify(spec.bodySources ?? {});
      const bodySourcesBytes = Buffer.byteLength(bodySourcesEnv, "utf8");
      if (bodySourcesBytes > WORKFLOW_BODY_SOURCES_MAX_BYTES) {
        throw new Error(
          `sidecar deploy router: serialized ${WORKFLOW_BODY_SOURCES_ENV_KEY} is ${String(bodySourcesBytes)} bytes, over the ${String(WORKFLOW_BODY_SOURCES_MAX_BYTES)}-byte spawn-env limit; the deployment has too many spawned-body sources to deliver through the child env`,
        );
      }

      const substrateEnv: Record<string, string> = {
        ...multistepSubstrateEnv,
        WORKFLOW_RUN_REPO_ID: runId,
        WORKFLOW_RUN_REF: "refs/heads/main",
        // Thread the materialized closure's sidecar-local package dir so the
        // run child EVALUATES the pinned code to a live definition and
        // re-verifies by project-then-hash against `DEFINITION_HASH`. Source-ref
        // is the only deploy lineage, so this is always present. Sidecar-local;
        // carried on the frozen substrate env because the value is fixed for the
        // deployment's lifetime.
        CLOSURE_PACKAGE_DIR: spec.closurePackageDir,
        [WORKFLOW_BODY_SOURCES_ENV_KEY]: bodySourcesEnv,
      };
      // Live-rotatable per-step inference sources. Seeded from the deploy
      // spec, then revised in place by the single-step sources-rotation
      // handler below. `STEP_INFERENCE_SOURCES` is NOT in the frozen
      // `substrateEnv`: it is recomputed on every spawn and recycle respawn
      // via `dynamicSpawnEnv`, so a rotation survives a recycle instead of
      // reverting to the deploy-time list.
      let currentSources = spec.sources;

      // RunIds whose `run.grants` write was attempted and failed. The grants
      // handler below records a runId here on a write failure; the grants
      // barrier reads it through `isRunPoisoned` and fails the run rather than
      // starting it under the empty deploy-time grant set. Scoped to this
      // deployment's supervisor; a run that never had a `run.grants` frame is
      // never added, so internal runs inherit the deployment's grants normally.
      const poisonedRunIds = new Set<string>();

      const wired = createSidecarWorkflowSupervisor({
        transport: deps.transport,
        repoStore: deps.repoStore,
        signingKeySeed: deps.signingKeySeed,
        workflowRunRepoId: {
          kind: "workflow-run",
          id: runId,
        },
        workflowRunRef: "refs/heads/main",
        runId,
        stepCount: spec.definition.stepOrder.length,
        stepOrder: credentialStepIds,
        deploymentMailAddress: spec.agentAddress,
        ...(credentialDelivery !== undefined ? { credentialDelivery } : {}),
        deriveStepAddress: stepStrategy.deriveStepAddress,
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        isRunPoisoned: (runId) => poisonedRunIds.has(runId),
        // The supervisor stamps `runId` + `agentAddress` before
        // invoking this; forward the fully-stamped registration to the
        // hub-link-backed publisher so a `signal.correlation.register` frame
        // reaches the hub for the parked run.
        onSuspensionRegister: publishSuspension,
        // Reclaim the deployment address when the supervisor drives itself to a
        // terminal phase (crash-loop latch, channel crash, recycle failure) so
        // the dead supervisor is dropped from `activeSupervisors` and the
        // address is redeployable without a manual undeploy first.
        onSelfTerminate: () =>
          reclaimSelfTerminatedSupervisor({
            runId,
            agentAddress: spec.agentAddress,
          }),
        substrateEnv,
        // Recomputed on every spawn AND recycle respawn. The rotation
        // handler below revises `currentSources` in place, so a respawn
        // re-serializes the current (possibly rotated) list rather than the
        // frozen deploy-time value.
        dynamicSpawnEnv: () => ({
          [STEP_INFERENCE_SOURCES_ENV_KEY]: JSON.stringify(currentSources),
        }),
        subprocessSpawner: multistepSpawner,
        ...(deps.multistepBinaryPath !== undefined ? { binaryPath: deps.multistepBinaryPath } : {}),
        ...(deps.onDispatchTiming !== undefined ? { onDispatchTiming: deps.onDispatchTiming } : {}),
        ...(deps.repackEveryMessages !== undefined
          ? { repackEveryMessages: deps.repackEveryMessages }
          : {}),
        ...(deps.consumedRetentionMs !== undefined
          ? { consumedRetentionMs: deps.consumedRetentionMs }
          : {}),
        ...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
      });

      // Every step signs outbound sends as spec.agentAddress, so the transport must hold a CryptoProvider for it before spawn() or getTransportFor throws "not registered".
      const { keyPair } = await deps.keyStore.loadOrGenerateKey(spec.agentAddress);
      deps.transport.register(spec.agentAddress, deps.createAgentCrypto(keyPair));
      agentTransportRegistered = true;

      // Every deployment acks this key, single- and multi-step alike, so the Hub can publish the same identity.
      const deploymentPublicKey = hexEncode(keyPair.publicKey);
      if (spec.definition.stepOrder.length === 1) {
        // Idempotent init; the narrow initRepo (not provisionAgent) is deliberate since the supervised child mints its own keypair.
        await deps.sessions.initRepo(spec.agentAddress);

        // Verifier resolves this from the in-memory key store, so a single-step deployment cannot stand up without it.
        if (spec.hubPublicKey === undefined) {
          throw new Error(
            "sidecar deploy router: a single-step workflow deployment requires a hubPublicKey to record at the head; none was supplied",
          );
        }
        deps.keyStore.recordHubKey(spec.agentAddress, spec.hubPublicKey);
        hubKeyRecorded = true;
      }

      // The sole step IS the long-lived agent for single-step; multi-step keeps instantiate-send-teardown per step.
      const warmKeep = spec.definition.stepOrder.length === 1;
      const spawnOpts: SpawnOpts = {
        stepOrder: [...credentialStepIds],
        definitionHash,
        warmKeep,
        onInferenceEvent: (event) => {
          // A parse failure means upstream corruption, so drop loudly rather than forwarding an unvalidated payload onto the hub timeline.
          const validated = parseInferenceEvent(event);
          if (validated instanceof type.errors) {
            logger.warn`dropping workflow inference event for ${spec.agentAddress}: ${validated.summary}`;
            return;
          }
          publishInferenceEvent(spec.agentAddress, validated, spec.sessionId);
        },
      };

      // Recorded before spawn, since spawn's replayProcessingToInbox write resolves this mapping to address the outbound pack frame; recording after loses the race.
      deps.registerDeployment({
        runId,
        agentAddress: spec.agentAddress,
      });
      deploymentRegistered = true;

      // The supervisor is registered against the address only after spawn succeeds, so a spawn-time rejection leaves the registry untouched.
      await wired.supervisor.spawn(spawnOpts);
      wiredForUnwind = wired;
      activeSupervisors.set(spec.agentAddress, wired);
      supervisorRegistered = true;

      deps.multistepMailRouter?.register(spec.agentAddress, (message) =>
        wired.routeInbound(message),
      );
      // Resolved once, beside the mail-router registration, so the hub-link seam has the recipient's policy before any inbound frame can route.
      deps.inboundMailPolicyRegistry?.register(
        spec.agentAddress,
        resolveInboundMailPolicy(spec.definition.inboundMailPolicy),
      );
      deps.multistepSignalRouter?.register(spec.agentAddress, async (args) => {
        await wired.supervisor.deliverSignal({
          runId: args.runId,
          signalName: args.signalName,
          signalId: args.signalId,
          payload: args.payload,
        });
      });
      deps.multistepDrainRouter?.register(spec.agentAddress, async (args) => {
        await wired.supervisor.drain({ deadlineMs: args.deadlineMs });
      });
      // runId selects the per-run destination; the step-fan-out fields are inert here but the shared write machinery still takes them.
      deps.multistepGrantsRouter?.register(spec.agentAddress, async (args) => {
        try {
          // Cached before the grants file lands so "grant durable" implies "key durable"; a malformed key is skipped and logged at ERROR rather than wedging the run.
          for (const identity of args.senderIdentities ?? []) {
            let publicKey: Uint8Array;
            try {
              publicKey = hexDecode(identity.publicKey);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              logger.error`Skipping unparseable sender key for ${identity.address} on run ${args.runId}: ${message}`;
              continue;
            }
            if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
              logger.error`Skipping wrong-length sender key for ${identity.address} on run ${args.runId}: got ${String(publicKey.length)} bytes`;
              continue;
            }
            await deps.senderKeyCache.put(identity.address, publicKey);
          }
          await writeStepGrants({
            repoStore: deps.repoStore,
            anchorRunId: runId,
            stepOrder: spec.definition.stepOrder,
            deriveStepRepoId: stepStrategy.deriveStepRepoId,
            grants: args.stepGrants,
            runId: args.runId,
          });
        } catch (cause) {
          // Poison the runId so the grants barrier fails the run instead of starting it under the deploy-time grant set.
          poisonedRunIds.add(args.runId);
          throw cause;
        }
        // Best-effort and non-fatal: refreshes a live child so a standing approval lowers its floor immediately; a skipped push is healed by the next barrier/respawn.
        await wired.supervisor.deliverGrants(args.runId);
      });
      // Only a single-step warm deployment (one long-lived agent to swap sources on); multi-step registers none, so tryRoute reports its address as unrouted.
      if (warmKeep) {
        // The layer that owns the single-key invariant; deliverSources stays flat and stepId-agnostic.
        const rotationStepId = spec.definition.stepOrder[0];
        if (rotationStepId === undefined) {
          throw new Error("single-step deploy has no step id for sources rotation");
        }
        deps.multistepSourcesRouter?.register(spec.agentAddress, async (args) => {
          const rotated = { [rotationStepId]: args.sources };
          // Swapped before the durable persist so a recycle interleaving the
          // persist await respawns on the SAME sources being persisted, not
          // the stale prior table; a failed persist rolls the hint back so
          // the only residual disagreement is child-ahead-of-durable, which
          // the next recycle heals down to the rolled-back durable truth.
          const prevSources = currentSources;
          currentSources = rotated;
          // Skipped when no data dir was wired (a test router that never persists), matching the restore guard.
          if (stepStateDataDir !== undefined) {
            try {
              await persistWorkflowRunRecord(
                stepStateDataDir,
                runId,
                buildWorkflowRunRecord(spec, rotated),
                deps.credentialCipher,
              );
            } catch (cause) {
              // Safe because the sidecar's per-connection inbound-frame queue serializes rotations for one deployment, so no second rotation is in flight.
              currentSources = prevSources;
              throw cause;
            }
          }
          await wired.supervisor.deliverSources({
            sources: args.sources,
            defaultSource: args.defaultSource,
          });
        });
      }

      // For EVERY deployment (not only warm single-step): the material cell is per-child. No durable persist; credential material never touches disk.
      deps.multistepCredentialsRouter?.register(spec.agentAddress, async (args) => {
        await wired.supervisor.deliverCredentials({
          delivery: args.delivery,
          ...(args.revoke !== undefined ? { revoke: args.revoke } : {}),
        });
      });
      routersRegistered = true;

      succeeded = true;
      return { publicKey: deploymentPublicKey };
    } finally {
      if (!succeeded) {
        // Unwind in reverse registration order so each step undoes state
        // the success path confirmed; ordering matches the `undeploy` hook.
        if (routersRegistered) {
          deps.multistepMailRouter?.unregister(spec.agentAddress);
          deps.inboundMailPolicyRegistry?.unregister(spec.agentAddress);
          deps.multistepSignalRouter?.unregister(spec.agentAddress);
          deps.multistepDrainRouter?.unregister(spec.agentAddress);
          deps.multistepGrantsRouter?.unregister(spec.agentAddress);
          // unregister is a no-op for an address that never registered, so a multi-step unwind safely calls this too.
          deps.multistepSourcesRouter?.unregister(spec.agentAddress);
          deps.multistepCredentialsRouter?.unregister(spec.agentAddress);
        }
        if (supervisorRegistered) {
          activeSupervisors.delete(spec.agentAddress);
        }
        if (wiredForUnwind !== undefined) {
          await wiredForUnwind.supervisor.shutdown().catch((cause) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            logger.warn`multi-step deploy unwind: supervisor.shutdown failed: ${message}`;
          });
        }
        if (agentTransportRegistered) {
          // Drop the agent's transport registration so a failed deploy does
          // not leave the address live with a dangling `CryptoProvider`.
          deps.transport.unregister(spec.agentAddress);
        }
        if (hubKeyRecorded) {
          // forgetAgent also drops the keypair cache, safe since a redeploy reloads it from disk. The on-disk deploy-tree repo is deliberately NOT reversed: it holds the durable identity keypair a rerouted head must keep.
          deps.keyStore.forgetAgent(spec.agentAddress);
        }
        if (deploymentRegistered) {
          // Reverse the pre-spawn `registerDeployment`: drop the address
          // mapping so a failed spawn leaves the boot-edge registry as it
          // found it. Registered first (before spawn), unwound last. A
          // subsequent stale workflow-run write for the dead deployment then
          // surfaces structurally (`registry.resolve` returns null) rather
          // than resolving to the address of a deployment that never came up.
          deps.unregisterDeployment({
            runId,
            agentAddress: spec.agentAddress,
          });
        }
      }
    }
  }

  /**
   * Provisions one step of a multi-step deploy WITHOUT spawning (same
   * initRepo + recordHubKey seam the single-step head uses), since a
   * full-closure deploy pack needs an initialized repo before the
   * deployment-level workflow frame spawns the child.
   */
  async function provisionStep(frame: AgentDeployFrame): Promise<DeployRouterResult> {
    await deps.sessions.initRepo(frame.agentAddress);
    deps.keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
    return {
      publicKey: await derivePrincipalPublicKeyHex(deps.signingKeySeed),
    };
  }

  async function deployMultiStep(
    frame: AgentDeployFrame,
    projection: NonNullable<AgentDeployFrame["workflow"]>,
  ): Promise<DeployRouterResult> {
    // activeSupervisors catches a completed deploy; reservingDeployAddresses
    // catches one still in flight, closing the window before spawn populates
    // the map, where two frames could both pass and the loser deletes the
    // winner's live record.
    if (
      activeSupervisors.has(frame.agentAddress) ||
      reservingDeployAddresses.has(frame.agentAddress)
    ) {
      throw new Error(
        `sidecar deploy router: ${frame.agentAddress} is already deployed; undeploy it before redeploying`,
      );
    }

    const runId = deriveDeploymentId(frame.agentAddress);

    // The run record, materialized closure, and per-step scratch all root under this.
    const dataDir = stepStateDataDir;
    if (typeof dataDir !== "string" || dataDir.length === 0) {
      throw new Error(
        "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the run record and workflow-process child root under it",
      );
    }

    // Claimed before any durable write so a colliding runId is rejected before disk is touched; released on failure, kept on success (undeploy releases it).
    claimSlug(runId, frame.agentAddress);
    reservingDeployAddresses.add(frame.agentAddress);
    try {
      // Materializes the hub's frozen closure byte-for-byte (never re-resolves the pin); the child's load-boundary re-verify fails closed if it diverges from the hub-approved hash.
      // Reclaims the store first so a redeploy drops unreferenced assets; runs only on the deploy path since restore re-reads what deploy persisted, with no re-delivery.
      const assetStore = deploymentSourceAssetRoot(dataDir, runId);
      const gitStore = deploymentSourceGitRoot(dataDir, runId);
      await rm(assetStore, { recursive: true, force: true });
      await rm(gitStore, { recursive: true, force: true });
      if (projection.assets !== undefined && projection.assets.length > 0) {
        await materializeWorkflowAssets({
          assets: projection.assets,
          closure: projection.sourceRef.closure,
          assetRoot: assetStore,
          gitDirRoot: gitStore,
          maxAssetPayloadBytes: MAX_INLINE_ASSET_PAYLOAD_BYTES,
        });
      }
      // Safe: this deploy is single-flight-guarded and the child is not yet spawned, so no live reader holds the instance dir.
      const applied = await materializeDeploymentClosure(dataDir, runId, projection.sourceRef);
      const validatedDefinition = WorkflowProjectionDefinition(
        projectLiveToInert(applied.definition),
      );
      if (validatedDefinition instanceof type.errors) {
        throw new Error(
          `sidecar deploy router: workflow definition loaded from the frozen closure failed projection validation: ${validatedDefinition.summary}`,
        );
      }
      const effectiveDefinition = validatedDefinition;

      // Checked against the closure-derived definition since the wire arktype doesn't cover it and the frame carries none. Mirrors the restore path.
      validateWorkflowProjection({
        definition: effectiveDefinition,
        sources: projection.sources,
      });

      // Every source in a step's failover chain must be buildable, since an unbuildable tail would fail only after the reactor failed over onto it.
      for (const stepId of effectiveDefinition.stepOrder) {
        const chain = projection.sources[stepId];
        if (chain !== undefined) {
          for (const source of chain) deps.assertSourceBuildable(source);
        }
      }

      // Single-agent deploy vs. derived multi-step deploy. A one-step
      // definition keeps the deploy's own mail address and its grants in the
      // agent-state repo keyed by the run id; a multi-step definition derives
      // `<runId>-<stepId>` per step for both the mail address and the
      // agent-state repo id, isolating each step's grants in its own repo.
      const stepStrategy = createStepStrategy({
        legacyAddress: frame.agentAddress,
        stepOrder: effectiveDefinition.stepOrder,
        multistepDeriveStepAddress,
      });

      // The spec the shared spawn core consumes, and the durable record that
      // lets a boot-time restore rebuild the SAME spec (definition re-evaluated
      // from the pinned closure, grants from the step repos, and the record's
      // frame/in-memory-only inputs: sources, session id, single-step hub key).
      const spec: WorkflowDeploySpec = {
        agentAddress: frame.agentAddress,
        definition: effectiveDefinition,
        sources: projection.sources,
        bodySources: buildBodySourcesMap(projection.referencedDefinitions),
        // The hub's unified credential-material cell (inference + tool secrets);
        // persisted sealed in the record and delivered on the barrier.
        credentials: projection.credentials,
        approvedWireHash: projection.approvedWireHash,
        sessionId: frame.config.sessionId,
        hubPublicKey: effectiveDefinition.stepOrder.length === 1 ? frame.hubPublicKey : undefined,
        // The sidecar-local dir of the just-materialized closure the spawn core
        // threads into the child's env so it re-evaluates the pinned code.
        closurePackageDir: applied.packageDir,
        // The source-ref pin the record persists so a restore can
        // re-materialize the closure.
        sourceRef: projection.sourceRef,
      };
      const record = buildWorkflowRunRecord(spec, spec.sources);

      // Persist the run record BEFORE the spawn so a crash mid-spawn leaves a
      // record the boot scan re-drives (an idempotent re-spawn; the child's
      // in-flight-run discovery resumes any run). A soft-failed deploy deletes
      // it below, so only a crash-interrupted deploy leaves one.
      await persistWorkflowRunRecord(dataDir, runId, record, deps.credentialCipher);

      // Sweep any legacy plaintext body-source file this deployment's bodies
      // left behind. Body sources now ride sealed in the run record and reach
      // the child through the spawn env, so the `assets/workflow/<bodyRef>/`
      // staging is retired. A deployment first seen on this build never wrote
      // one (the rm is a no-op); a redeploy across the upgrade -- or the reconnect
      // re-push -- reaches here with its old world-readable plaintext file still
      // on disk and removes it now that the record carries the sealed copy.
      for (const referenced of projection.referencedDefinitions ?? []) {
        await sweepLegacyBodySources(dataDir, referenced.definition.id);
      }

      // Grants bridge: the spawned child does not see the frame; it reads
      // each step's grants out of `state/grants.json` in the step's
      // agent-state repo while the supervisor assembles the
      // credentialsSnapshot. Write the operator-approved
      // `frame.config.grants` to the same repo the supervisor reads via
      // `deriveStepRepoId`, before the spawn core, so the read sees them.
      //
      // The write covers the deployment's whole flat step-id namespace, loop
      // body steps included: the supervisor assembles a snapshot entry for each
      // of them, and an entry read out of a repo that was never written carries
      // an empty grant set, which denies the body every resource the deploy
      // approved.
      await writeStepGrants({
        repoStore: deps.repoStore,
        anchorRunId: runId,
        stepOrder: inertFlatNamespaceStepIds({
          definition: effectiveDefinition,
          context: "sidecar deploy router grants bridge: ",
        }),
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        grants: frame.config.grants,
      });

      // Hand off to the shared spawn core.
      return await spawnWorkflowRun(spec);
    } catch (cause) {
      // Soft failure (this process survived, the deploy threw): drop the
      // record and release the slug so the failed deploy is neither restored
      // nor leaks its slug. The record delete must not mask the real deploy
      // error or skip releasing the slug: a rejecting delete is logged (the
      // orphaned record is a durable-state leak the next boot scan re-drives)
      // but `cause` is still what propagates and the slug is still released.
      try {
        await deleteWorkflowRunRecord(dataDir, runId);
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logger.error`deploy cleanup: deleteWorkflowRunRecord failed for ${runId}: ${message}`;
      }
      releaseSlug(runId, frame.agentAddress);
      throw cause;
    } finally {
      // Release the single-flight reservation whether the deploy succeeded or
      // threw. On success the address is now in `activeSupervisors`, which the
      // guard also consults, so a later re-deploy is still rejected.
      reservingDeployAddresses.delete(frame.agentAddress);
    }
  }

  return {
    async deploy(frame): Promise<DeployRouterResult> {
      if (frame.provisionStep === true) {
        return await provisionStep(frame);
      }
      if (frame.workflow !== undefined) {
        return await deployMultiStep(frame, frame.workflow);
      }
      // Every deploy stages through the workflow-run substrate: a
      // provision-step frame primes the per-step repo, and a workflow
      // frame spawns the supervised child. A frame carrying neither is
      // an unsupported shape -- there is no in-process fall-through.
      throw new Error(
        `sidecar deploy router: unsupported deploy frame for ${frame.agentAddress}; a deploy must carry provisionStep or a workflow definition`,
      );
    },
    async undeploy(frame): Promise<void> {
      // Symmetric teardown for `deploy`: release the per-deployment
      // routing state both branches install so a stale `signal.deliver`
      // / `drain.deliver` / `mail.inbound` aimed at the dead deployment
      // address is rejected by the router rather than dispatched into
      // an orphan supervisor handler. The unregister calls are
      // idempotent -- they are no-ops when no handler is registered.
      //
      // Routers come down BEFORE the supervisor's `shutdown()` so any
      // hub-side frame racing the undeploy is dropped at the router
      // boundary rather than dispatched into a supervisor that is in
      // the middle of tearing its child down. The pattern is: drop
      // racing frames first, then unwind the underlying resource.
      const runId = deriveDeploymentId(frame.agentAddress);
      deps.multistepMailRouter?.unregister(frame.agentAddress);
      deps.inboundMailPolicyRegistry?.unregister(frame.agentAddress);
      deps.multistepSignalRouter?.unregister(frame.agentAddress);
      deps.multistepDrainRouter?.unregister(frame.agentAddress);
      deps.multistepGrantsRouter?.unregister(frame.agentAddress);
      // Unregister unconditionally (a no-op for a multi-step address that
      // registered no sources handler), matching the sibling routers.
      deps.multistepSourcesRouter?.unregister(frame.agentAddress);
      deps.multistepCredentialsRouter?.unregister(frame.agentAddress);
      // Shut the per-deployment supervisor down so the workflow-process
      // child, its IPC pipes, and its event-channel fd are released.
      // The supervisor's `shutdown()` is idempotent (returns early when
      // the supervisor is already in `idle`/`stopped`) and handles the
      // kill + `exited` await internally. The map entry is removed
      // before the await so a subsequent re-deploy on the same address
      // cannot observe a stale handle even if `shutdown()` rejects.
      const wired = activeSupervisors.get(frame.agentAddress);
      if (wired !== undefined) {
        activeSupervisors.delete(frame.agentAddress);
        await wired.supervisor.shutdown();
        // Drop the deployment address's transport registration installed at
        // spawn (OUTBOUND half of mailbox ownership, §3a). Both single- and
        // multi-step register the deployment address for outbound signing, so
        // this tears down a real registration for either; `unregister` is a
        // no-op only if the spawn failed before registering, so it is safe to
        // call unconditionally for any spawned deployment.
        deps.transport.unregister(frame.agentAddress);
        // Reclaim the deployment's per-step local-disk scratch now that
        // its supervisor + workflow-process child are torn down. The
        // whole `workflow-step-state/<runId>/` subtree goes: the
        // warm single-step agent's stable workspace under `warm/` (the
        // dir bounded keying parks per agent) AND any cold `runs/<runId>/`
        // subtrees a multi-step deploy's per-run cleanup did not already
        // drop. Awaiting `shutdown()` above guarantees no child still
        // holds the scratch, so this is a safe `rm -rf`. The durable
        // conversation under `agent-conversation-state/` is a DIFFERENT
        // root and is deliberately NOT touched here -- a re-deploy on the
        // same address must restore the prior conversation from it.
        if (stepStateDataDir !== undefined) {
          await rm(pathJoin(stepStateDataDir, "workflow-step-state", runId), {
            recursive: true,
            force: true,
          });
        }
      }
      // Drop the run record so a boot-time restore does not re-spawn a
      // torn-down deployment, and reclaim a source-ref deployment's
      // materialized closure tree AND its durable source-asset store. All run
      // on every undeploy -- not only when a supervisor was active -- so state
      // left behind by a crash-interrupted deploy, or by a source-ref restore
      // that materialized the closure and then failed to spawn (registry down),
      // is reclaimed too. A registry-sourced deployment never creates the source
      // store, so its `force` remove is a no-op there.
      if (stepStateDataDir !== undefined) {
        await deleteWorkflowRunRecord(stepStateDataDir, runId);
        await rm(pathJoin(stepStateDataDir, "workflow-definition-closures", runId), {
          recursive: true,
          force: true,
        });
        await rm(deploymentSourceAssetRoot(stepStateDataDir, runId), {
          recursive: true,
          force: true,
        });
        await rm(deploymentSourceGitRoot(stepStateDataDir, runId), {
          recursive: true,
          force: true,
        });
      }
      releaseSlug(runId, frame.agentAddress);
      deps.unregisterDeployment({
        runId,
        agentAddress: frame.agentAddress,
      });
    },
    async restoreWorkflowRuns(): Promise<void> {
      const dataDir = stepStateDataDir;
      if (dataDir === undefined) {
        // No substrate config was wired (a test router that never spawns a
        // child): nothing was ever persisted under this data dir, so there
        // is nothing to restore.
        return;
      }

      const scanned = await scanWorkflowRunRecords(dataDir, deps.credentialCipher);
      // Restore serially, not in parallel: deterministic boot-log ordering,
      // one isolable warning per failed record, and no concurrent
      // child-spawn / transport-register storm. Restore runs before
      // `hubLink.connect()`, so there are no concurrent deploys to contend
      // with. Each record's failure is caught so one bad deployment cannot
      // strand the rest.
      for (const { runId, record } of scanned) {
        try {
          // Integrity: the stored address must re-derive to its own directory
          // name. A mismatch means a corrupt or misplaced record; skip it
          // rather than restore a deployment under the wrong slug. (A source-ref
          // record missing its source/closure/approvedWireHash is rejected
          // earlier, at the scan boundary, by the record schema's discriminated
          // union -- so no bespoke source-ref guard is needed here.)
          const derived = deriveDeploymentId(record.agentAddress);
          if (derived !== runId) {
            logger.warn`skipping workflow deployment restore: ${record.agentAddress} derives slug ${derived}, not its directory ${runId}`;
            continue;
          }

          // Reconstruct this deployment's runnable definition. Source-ref is
          // the only lineage: re-materialize the pinned closure and evaluate the
          // pinned code to the live definition, then project it to the inert
          // wire shape -- the SAME computation the deploy path applies
          // (`WorkflowProjectionDefinition(projectLiveToInert(...))`). The
          // closure IS the source of truth; no on-disk definition is read. The
          // helper reclaims the instance dir first, which is safe here because
          // the prior process (the only reader) is dead and restore is serial
          // before `hubLink.connect()`, so no concurrent reader holds it.
          // Registry-sourced entries fetch from the content-addressed closure
          // cache (a hit populated on the original deploy, surviving restart);
          // asset-sourced entries read from the durable source store the
          // original deploy checked out (`materializeDeploymentClosure` derives
          // the mounts from the pin, so no re-delivery is needed). Both are
          // SRI-verified. A cache/store miss soft-fails the record (kept for the
          // next boot), matching the `assertSourceBuildable` retry-on-later-boot
          // behavior below. The schema guarantees a source-ref record carries a
          // `sourceRef` pin, so no undefined-check is needed.
          const applied = await materializeDeploymentClosure(dataDir, runId, record.sourceRef);
          const validatedDefinition = WorkflowProjectionDefinition(
            projectLiveToInert(applied.definition),
          );
          if (validatedDefinition instanceof type.errors) {
            logger.warn`skipping workflow deployment restore for ${record.agentAddress}: workflow definition loaded from the frozen closure failed projection validation: ${validatedDefinition.summary}`;
            continue;
          }
          const definition: WorkflowProjectionDefinition = validatedDefinition;
          const closurePackageDir = applied.packageDir;

          // Structural invariants the wire arktype does not cover (non-empty
          // stepOrder, every stepOrder entry backed by a `steps` entry AND a
          // `sources` entry). The closure eval skips the deploy frame's coverage
          // narrow, so this is where its definition-vs-sources coverage is
          // checked.
          validateWorkflowProjection({ definition, sources: record.sources });

          // Re-run the source-admission gate: refuse to restore a deployment
          // whose pinned provider this sidecar can no longer build. Every
          // source in a step's failover chain must be buildable, so this
          // iterates the whole list. The record is KEPT (not deleted) so a
          // later boot with the provider restored retries it.
          for (const stepId of definition.stepOrder) {
            const chain = record.sources[stepId];
            if (chain !== undefined) {
              for (const source of chain) deps.assertSourceBuildable(source);
            }
          }

          const spec: WorkflowDeploySpec = {
            agentAddress: record.agentAddress,
            definition,
            sources: record.sources,
            // The record's unsealed body sources, re-delivered to the run child
            // through the spawn env. `undefined` for a legacy record written
            // before body sources were persisted here; the child then falls back
            // to that deployment's on-disk plaintext file for the missing bodies.
            bodySources: record.bodySources,
            // The record's credential-material cell, unsealed by the boot scan
            // and re-delivered to the child on the pre-trigger barrier so an
            // offline restart restores both inference and tool credentials
            // without the hub. `undefined` when the deployment bound none.
            credentials: record.credentials,
            // The hub-approved wire hash the original deploy persisted, so the
            // restore re-spawn carries the same `DEFINITION_HASH` rather than a
            // recompute. Always present -- the record schema requires it.
            approvedWireHash: record.approvedWireHash,
            sessionId: record.sessionId,
            hubPublicKey: record.hubPublicKey,
            // The sidecar-local dir of the just-materialized closure the spawn
            // core threads into the child's env so it re-evaluates the pinned
            // code.
            closurePackageDir,
            // Carry the source-ref pin so a post-restore source rotation --
            // which rebuilds the record from the spec -- re-persists it; without
            // this a rotation would silently drop it and wedge the NEXT restart.
            sourceRef: record.sourceRef,
          };

          // The slug is the caller's, matching `deployMultiStep`: claim before
          // the spawn, release on failure. Unlike deploy's soft-fail, restore
          // does NOT delete the record and does NOT re-materialize the step
          // grants or the onTrigger body sources -- both are already on disk
          // from the original deploy. A failed restore just warns and
          // leaves the record for the next boot; there is deliberately no GC
          // of a permanently-unrestorable record here (an operator reclaims it
          // by undeploying the address).
          //
          // Release only a slug THIS pass newly claimed: if the address is
          // already live (its slug still held by the running deployment), the
          // core's double-spawn guard throws, and freeing the slug then would
          // strand a live deployment's collision guard. `claimSlug` is a
          // no-op for an already-held (runId, address) pair, so the
          // pre-claim check distinguishes the two.
          const slugNewlyClaimed = slugClaims.get(runId) !== record.agentAddress;
          claimSlug(runId, record.agentAddress);
          try {
            await spawnWorkflowRun(spec);
            logger.info`Restored workflow deployment for ${record.agentAddress}`;
          } catch (cause) {
            if (slugNewlyClaimed) {
              releaseSlug(runId, record.agentAddress);
            }
            throw cause;
          }
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          logger.warn`Failed to restore workflow deployment ${runId}: ${reason}`;
        }
      }
    },
    activeAddresses(): string[] {
      // `activeSupervisors` is keyed by deployment run address and holds
      // exactly the deployments with a live supervisor (deploy and restore
      // add; undeploy and spawn-unwind remove), so its keys are the addresses
      // this sidecar can currently route mail to.
      return [...activeSupervisors.keys()];
    },
    reEmitParkedCorrelations(address: string): void {
      const wired = activeSupervisors.get(address);
      if (wired === undefined) {
        // Edge boundary: the hub reports this address routable but no live
        // supervisor owns it -- a deployment torn down, or not yet respawned.
        // Re-registering a torn-down deployment would be wrong, so skipping is
        // correct. Logged at debug (not warn) so a supervisor unexpectedly
        // missing for a live deployment is still traceable without crying wolf
        // on the ordinary torn-down case.
        logger.debug`re-emit on reconnect: no active supervisor for ${address}; skipping`;
        return;
      }
      // Fire-and-forget: the driver is best-effort and watchdog-bounded inside
      // the supervisor, so the reconnect fan-out never awaits it. The promise
      // is dropped deliberately; the `.catch` is defense-in-depth since the
      // driver already swallows its own query failures.
      void wired.supervisor.reEmitParkedCorrelations().catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn`re-emit of parked correlations on hub reconnect failed for ${address}: ${message}`;
      });
    },
  };
}

/**
 * Logical mail-audit reference the supervisor stamps onto every
 * inbox/processing/consumed envelope for sidecar-hosted deployments.
 * The substrate does not dereference the value; it is a host-side
 * pointer the audit consumer joins on. The mail audit is keyed by the
 * deployment id plus the parsed messageId, which is unique per inbound
 * message and stable across the FIFO pipeline's
 * enqueue/dequeue/markConsumed transitions.
 */
export function deriveSidecarMailAuditRef(runId: string): (
  messageId: string,
  rawMessage: Uint8Array,
) => {
  store: string;
  path: string;
} {
  return (messageId, _rawMessage) => ({
    store: "sidecar-mail-audit",
    path: `${runId}/${messageId}`,
  });
}

/**
 * Construct a per-deployment supervisor with the sidecar's bindings
 * pre-wired. The router calls this once per multi-step `agent.deploy`
 * frame to stand up the workflow-process child that hosts the
 * deployment.
 */
export function createSidecarWorkflowSupervisor(
  opts: CreateSidecarWorkflowSupervisorOpts,
): SidecarWorkflowSupervisor {
  const mailBus: HubTransportMailBusAdapter = wrapHubTransportAsMailBus(opts.transport);
  const supervisorPrincipal: WorkflowRunSupervisorPrincipal = {
    kind: "supervisor",
    anchorRunId: opts.runId,
  };
  // Per-run grants sink. The supervisor awaits this and pushes the
  // resulting snapshot to the child before the run's `trigger.fire`; a
  // throw propagates and the dispatch barrier fails the run rather than
  // firing the trigger against absent grants. The snapshot is the run's
  // own per-run grants file, which every legitimate birth path writes
  // before dispatch (see `assembleRunCredentialsSnapshot`).
  const onRunStart = (args: {
    runId: string;
    anchorRunId: string;
  }): Promise<CredentialsSnapshot> => {
    // Fail closed on a run whose `run.grants` write was recorded as failed:
    // its per-run grants file never landed. This is the known-failed-write
    // case, distinct from the general absent-file backstop in
    // `assembleRunCredentialsSnapshot` -- both fail the run closed, but this
    // one names the recorded write failure specifically so a poisoned run's
    // diagnostics point at the failed push rather than a generic absence.
    if (opts.isRunPoisoned?.(args.runId) === true) {
      return Promise.reject(
        new Error(
          `sidecar onRunStart: run ${args.runId} grants write failed; refusing to start the run under-authorized`,
        ),
      );
    }
    return assembleRunCredentialsSnapshot({
      repoStore: opts.repoStore,
      anchorRunId: args.anchorRunId,
      runId: args.runId,
      stepOrder: opts.stepOrder,
      deriveStepAddress: opts.deriveStepAddress,
    });
  };
  const supervisor = createWorkflowSupervisor({
    repoStore: opts.repoStore,
    signAsPrincipal: async (kind, payload) => {
      const sig = await signEd25519(opts.signingKeySeed, payload);
      return { sig, principalKind: kind };
    },
    mailBus,
    subprocessSpawner: opts.subprocessSpawner ?? defaultSubprocessSpawner,
    binaryPath: opts.binaryPath ?? SIDECAR_WORKFLOW_CHILD_BINARY,
    substrateEnv: opts.substrateEnv,
    dynamicSpawnEnv: opts.dynamicSpawnEnv,
    workflowRunRepoId: opts.workflowRunRepoId,
    workflowRunRef: opts.workflowRunRef,
    anchorRunId: opts.runId,
    stepCount: opts.stepCount,
    deploymentMailAddress: opts.deploymentMailAddress,
    readPrincipal: supervisorPrincipal,
    deriveStepAddress: opts.deriveStepAddress,
    onRunStart,
    ...(opts.credentialDelivery !== undefined
      ? { credentialDelivery: opts.credentialDelivery }
      : {}),
    ...(opts.onSuspensionRegister !== undefined
      ? { onSuspensionRegister: opts.onSuspensionRegister }
      : {}),
    ...(opts.onSelfTerminate !== undefined ? { onSelfTerminate: opts.onSelfTerminate } : {}),
    ...(opts.deriveStepRepoId !== undefined ? { deriveStepRepoId: opts.deriveStepRepoId } : {}),
    deriveMailAuditRef: deriveSidecarMailAuditRef(opts.runId),
    ...(opts.onDispatchTiming !== undefined ? { onDispatchTiming: opts.onDispatchTiming } : {}),
    ...(opts.repackEveryMessages !== undefined
      ? { repackEveryMessages: opts.repackEveryMessages }
      : {}),
    ...(opts.consumedRetentionMs !== undefined
      ? { consumedRetentionMs: opts.consumedRetentionMs }
      : {}),
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
  });
  return {
    supervisor,
    routeInbound(message) {
      return mailBus.routeInbound(opts.deploymentMailAddress, message);
    },
    getCredentialsSnapshot: () => supervisor.getCredentialsSnapshot(),
    onRunStart,
  };
}
