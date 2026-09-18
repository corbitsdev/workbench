// Single-writer architecture: the workflow-run repo's ref has exactly one
// writer, the supervisor. The child's bare RepoStore is read-only; its
// proxy RepoStore forwards writeTreePreservingPrefix over control IPC into
// the supervisor's substrate, which is wrapped with the boot-edge
// pack-push facade, so the child never opens its own pack-push pipeline.
// The factory does not read process.env itself; the binary owns that boundary.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import { InferenceSource } from "@intx/types/runtime";
import type {
  ApprovalSnapshot,
  AuditStore,
  ContextStore,
  InboundMessage,
  InferenceEvent,
  MessageTransport,
  PendingOperation,
} from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { AdapterManifest, createDependencies, type AdapterRegistry } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { AnnotatedPluginFactory, DirectorRegistry } from "@intx/agent";
import { createDefaultDirectorRegistry } from "@intx/agent";
import {
  builtinCredentialProviders,
  createCredentialProviderRegistry,
  createHarnessRuntimeCapabilities,
  driveConnectorReplies,
  type AgentEventStream,
  type ConnectorReplyDrain,
  type CredentialProviderRegistry,
} from "@intx/harness";
import {
  rawAuthorizationCredentialProvider,
  xApiKeyCredentialProvider,
} from "@corbits/credential-header";
import { createMcpStreamableHttpCredentialProvider } from "@corbits/credential-mcp";
import { createSSHSignature } from "@intx/crypto";
import {
  createAgentRepoStore,
  WORKFLOW_RUN_AGENT_STATE_PREFIX,
  type Principal,
  type RepoId,
  type RepoStore,
  type WorkflowRunWorkflowProcessPrincipal,
} from "@intx/hub-sessions/substrate";
import { createIsogitStore } from "@intx/storage-isogit/node";
import {
  adaptHostScheduler,
  createChildMailboxReader,
  createCredentialsBackedAuthorize,
  createMailboxWatchRegistry,
  createProxyWorkflowRunRepoStore,
  createSupervisorBackedTransport,
  createWorkflowHostScheduler,
  createWorkflowRunBlobSubstrate,
  createWorkflowRunRepoStore,
  createWorkflowHostSignalChannel,
  createInMemorySpawnChild,
  createInMemorySpawnSuspendableChild,
  createWorkflowStepInvoker,
  hashGrants,
  loadWorkflowLoopFnsFromClosure,
  loadWorkflowPluginFactoriesFromClosure,
  loadWorkflowPluginToolDefinitionsFromClosure,
  type ChildMailboxReader,
  type ChildOutboundMailBridge,
  type CredentialsSnapshot,
  type CredentialsSnapshotRef,
  type GrantEvaluator,
  type LoadParkedApproval,
  type RunChildWorkflow,
  type RunSuspendableChild,
  type RunWorkflowChildBindings,
  type SourcesSnapshotRef,
  type StepEnvBase,
  type SubstrateFactory,
  type SubstrateFactoryEnv,
  type SupervisorBackedTransportInbound,
} from "@intx/workflow-host";
import {
  baseStepId,
  collectDeclaredPluginNames,
  createLoopIterationHandle,
  createNoopDrainController,
  createSuspendableChildHandle,
  eagerlyResolveLoopFns,
  emptyState,
  enumerateInlineLoopBodies,
  rewriteInlineChildWorkflowBodies,
  runtimeRun,
  walkWorkflowSteps,
  LOOP_BODY_DESCENT,
  type LoopFnRegistry,
  type ParkedApprovalOp,
  type ReadParkedApprovalOps,
  type Scheduler,
  type StepInvokeRequest,
  type StepInvokeResult,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import { type PluginToolDefinitions } from "@intx/workflow-deploy";

import {
  attachStepCredentialWiring,
  attachStepTools,
  createToolBearingAgentFactory,
  deriveToolMarkFloorGrants,
  materializeStepTools,
  type StepToolCacheConfig,
  type StepToolMaterialization,
} from "./step-agent-tools";
import {
  createInferenceCredentialResolver,
  type CredentialMaterialCell,
} from "./step-credential-capabilities";
import { readRunGrants, runGrantsPath } from "./run-grants";
import { collectDeclaredResources, filterGrantsToDeclaredResources } from "./child-grant-filter";
import {
  createDurableConversationRegistry,
  isErrnoNotFound,
  reconstructDurableConversation,
  type DurableConversationRegistry,
} from "./conversation-state";

/** Enforced presence-and-non-empty before the factory runs; HUB_WS_URL/SIDECAR_ID/SIDECAR_TOKEN are the hub trust anchors. */
export const SIDECAR_SUBSTRATE_CONFIG_KEYS = [
  "SIDECAR_DATA_DIR",
  "WORKFLOW_RUN_REPO_ID",
  "WORKFLOW_RUN_REF",
  "SIDECAR_SIGNING_PUBLIC_KEY",
  "SIDECAR_SIGNING_PRIVATE_KEY",
  "HUB_WS_URL",
  "SIDECAR_ID",
  "SIDECAR_TOKEN",
  "STEP_INFERENCE_SOURCES",
  "WORKFLOW_BODY_SOURCES",
  "SIDECAR_CACHE_MAX_BYTES",
  "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
  "SIDECAR_ADAPTER_MANIFEST",
] as const;

const SubstrateConfig = type({
  SIDECAR_DATA_DIR: "string > 0",
  WORKFLOW_RUN_REPO_ID: "string > 0",
  WORKFLOW_RUN_REF: "string > 0",
  SIDECAR_SIGNING_PUBLIC_KEY: "string > 0",
  SIDECAR_SIGNING_PRIVATE_KEY: "string > 0",
  HUB_WS_URL: "string > 0",
  SIDECAR_ID: "string > 0",
  SIDECAR_TOKEN: "string > 0",
  STEP_INFERENCE_SOURCES: "string > 0",
  // Always serialized by the deploy router (at least "{}"), so a missing key
  // child-side is a serialization bug and must fail loud here.
  WORKFLOW_BODY_SOURCES: "string > 0",
  SIDECAR_CACHE_MAX_BYTES: "string > 0",
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "string > 0",
  // Required like the byte-cap fields; re-validated against AdapterManifest
  // in parseAdapterManifest before any module is imported.
  SIDECAR_ADAPTER_MANIFEST: "string > 0",
}).onUndeclaredKey("ignore");

/** Re-parsed at the child boundary rather than trusting the wire, even though the boot edge already validated it. */
function parseByteCap(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `sidecar workflow-child substrate config: ${name} must be a positive finite number; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Each value is the step's ordered failover chain: element 0 active, the tail forward-only targets. */
const StepInferenceSourceTable = type({
  "[string]": InferenceSource.array().atLeastLength(1),
});
type StepInferenceSourceTable = typeof StepInferenceSourceTable.infer;

/** Rejected at the boundary with a structured error rather than deferred to a deep-stack buildEnv failure. */
function parseStepInferenceSources(raw: string): StepInferenceSourceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar workflow-child substrate config: STEP_INFERENCE_SOURCES is not valid JSON: ${reason}`,
    );
  }
  const validated = StepInferenceSourceTable(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar workflow-child substrate config: STEP_INFERENCE_SOURCES failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

/** Empty when the deployment spawns no bodies. */
const BodyInferenceSources = type({
  "[string]": StepInferenceSourceTable,
});
type BodyInferenceSources = typeof BodyInferenceSources.infer;

/** Mirrors parseStepInferenceSources: rejected at the boundary rather than deep in a body spawn. */
function parseBodyInferenceSources(raw: string): BodyInferenceSources {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar workflow-child substrate config: WORKFLOW_BODY_SOURCES is not valid JSON: ${reason}`,
    );
  }
  const validated = BodyInferenceSources(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar workflow-child substrate config: WORKFLOW_BODY_SOURCES failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

/**
 * Defense-in-depth re-validation at the deserialization boundary, not a
 * trust upgrade. A manifest specifier must resolve from both the sidecar's
 * and the child's module-resolution roots, and an adapter module must be
 * import-side-effect-free since it's imported once per process.
 */
export function parseAdapterManifest(raw: string): AdapterManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      "sidecar workflow-child substrate config: SIDECAR_ADAPTER_MANIFEST is not valid JSON",
      { cause },
    );
  }
  const validated = AdapterManifest(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar workflow-child substrate config: SIDECAR_ADAPTER_MANIFEST failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

/** A lookup miss here is a supervisor programmer error, not a wire-side failure. A scoped map-iteration id resolves to its base first. */
function createStepInferenceSourceResolver(
  table: StepInferenceSourceTable,
): (stepId: string) => InferenceSource[] {
  return (stepId: string): InferenceSource[] => {
    const base = baseStepId(stepId);
    const sources = table[base];
    if (sources === undefined) {
      const scopedNote =
        base === stepId ? "" : ` (normalized from scoped invocation id ${JSON.stringify(stepId)})`;
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: no InferenceSource pinned for stepId ${JSON.stringify(base)}${scopedNote}; the supervisor must populate frame.workflow.sources for every stepOrder entry`,
      );
    }
    return sources;
  };
}

function hexDecode(hex: string, name: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`${name} must be even-length hex; got ${String(hex.length)} chars`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`${name} contains non-hex characters`);
    }
    out[i] = byte;
  }
  return out;
}

/** Production omits these for the default disk-backed store; tests inject an in-memory stub. */
interface SidecarSubstrateFactoryDeps {
  /** Backs the child's read-only operations only; writes go through the proxy RepoStore over IPC instead. */
  createBareRepoStore?: (config: {
    dataDir: string;
    signingKey: { publicKey: Uint8Array; privateKey: Uint8Array };
  }) => RepoStore;
}

/** Binds the same Ed25519 keypair the bare RepoStore carries, matching the production signing surface. */
function createStepStorageSigner(signingKey: {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}): (payload: string) => Promise<string> {
  return (payload: string) =>
    Promise.resolve(createSSHSignature(payload, signingKey.privateKey, signingKey.publicKey));
}

/**
 * Rooted outside the workflow-run working tree to avoid the run-event log.
 * A crash-resume must reopen the same attempt-N it suspended under
 * (recovered via currentAttempt), or the reactor hangs on an empty gate.
 */
export function stepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "runs",
    args.runId,
    "steps",
    args.stepId,
    `attempt-${String(args.attempt)}`,
  );
}

/** Reclaiming this subtree on run completion drops every step/attempt the run produced in one rm -rf. */
function runStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "runs",
    args.runId,
  );
}

/**
 * Keyed by step identity, not runId, so the cached warm agent reuses one
 * workspace across every message and it survives a child respawn.
 * Reclaimed on undeploy under a warm/ sibling of the cold runs/ subtree.
 */
function warmStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  stepId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "warm",
    encodeURIComponent(args.stepId),
  );
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch (cause) {
    if (isErrnoNotFound(cause)) return false;
    throw cause;
  }
}

function findApprovalSnapshot(
  pendingOperations: readonly PendingOperation[],
  correlationId: string,
): ApprovalSnapshot | undefined {
  return pendingOperations.find((op) => op.correlationId === correlationId)?.approvalSnapshot;
}

/** Returns undefined when the parent is not in the mailbox (fresh thread, or an id that never arrived). */
async function resolveMailboxReferences(
  reader: ChildMailboxReader,
  inReplyTo: string,
): Promise<string[] | undefined> {
  const store = await reader.open();
  const parent = store.messages.find((m) => m.envelope.messageId === inReplyTo);
  if (parent === undefined) return undefined;
  return [...parent.envelope.references, parent.envelope.messageId];
}

/** directoryExists guard keeps this a pure read: createIsogitStore would otherwise mkdir+init a fresh repo. */
export async function readColdParkedPendingOperations(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
}): Promise<PendingOperation[]> {
  const storeDir = stepStorageRoot({
    dataDir: args.dataDir,
    workflowRunRepoId: args.workflowRunRepoId,
    runId: args.runId,
    stepId: args.stepId,
    attempt: args.attempt,
  });
  if (!(await directoryExists(storeDir))) return [];
  const store = await createIsogitStore(storeDir);
  const { pendingOperations } = await store.load();
  return pendingOperations;
}

export async function readColdParkedApprovalSnapshot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
  correlationId: string;
}): Promise<ApprovalSnapshot | undefined> {
  return findApprovalSnapshot(await readColdParkedPendingOperations(args), args.correlationId);
}

/**
 * Deliberately not through DurableConversationRegistry.acquire, whose first
 * acquire would write a substrate restore and front-run the warm agent's own
 * restore ordering.
 */
export async function readWarmParkedPendingOperations(args: {
  substrate: RepoStore;
  workflowRunRepoId: RepoId;
  stepId: string;
}): Promise<PendingOperation[]> {
  const agentStateDir = path.join(
    args.substrate.getRepoDir(args.workflowRunRepoId),
    WORKFLOW_RUN_AGENT_STATE_PREFIX,
    encodeURIComponent(args.stepId),
  );
  const reconstructed = await reconstructDurableConversation(agentStateDir, args.stepId);
  if (reconstructed === null) return [];
  return reconstructed.pendingOperations;
}

export async function readWarmParkedApprovalSnapshot(args: {
  substrate: RepoStore;
  workflowRunRepoId: RepoId;
  stepId: string;
  correlationId: string;
}): Promise<ApprovalSnapshot | undefined> {
  return findApprovalSnapshot(await readWarmParkedPendingOperations(args), args.correlationId);
}

/** The runtime reconstructs the lost SignalAwaited from correlationId + deadline alone; it must not see the reactor's internals. */
export function toParkedApprovalOps(pendingOperations: PendingOperation[]): ParkedApprovalOp[] {
  return pendingOperations
    .filter((op) => op.kind === "approval")
    .map((op) => ({
      correlationId: op.correlationId,
      ...(op.timeoutAt !== undefined ? { timeoutAtMs: op.timeoutAt } : {}),
    }));
}

export interface SidecarStepBuildEnvDeps {
  dataDir: string;
  workflowRunRepoId: RepoId;
  signer: (payload: string) => Promise<string>;
  /** Locates each step's deploy tree and doubles as the step agent's outbound mail address. */
  mailboxAddress: string;
  /** Selects the head/step collapse: single-step reads at the head, multi-step at the per-step address. */
  stepCount: number;
  /** Wrapped in a supervisor-backed transport; the step agent never holds the signing key. */
  outboundMailBridge: ChildOutboundMailBridge;
  /** Absent for a build with no inbound mailbox (a spawned child or onTrigger body), whose inbound stays inert. */
  inbound?: SupervisorBackedTransportInbound;
  /** Per-step tool-loader caps (cache + registry tarball size). */
  cache: StepToolCacheConfig;
  /** Built eagerly at boot so a custom-provider step source resolves the same way as the sidecar main path. */
  adapters: AdapterRegistry;
  /** Present only for a warm single-step agent; a multi-step deploy's per-step agents need no cross-run durability. */
  durableConversation?: DurableConversationRegistry;
  /**
   * Recorded by base step id so the grant evaluator can authorize a pinned
   * tool (invisible to the hub's capability walk) against its own static
   * mark; persists across a warm agent's messages since the env builder
   * runs once.
   */
  recordToolMarkFloor: (baseStepId: string, grants: GrantRule[]) => void;
  /**
   * Set for the source-ref lineage: feeds the step agent's own live
   * toolFactories in directly, since that lineage stages no
   * tool-packages-manifest.json. No floor is recorded here since the
   * probe's capability walk already granted the bare tool name.
   */
  sourceTools: boolean;
  /** Present only on the source-ref lineage, to materialize its declared plugin packages with no re-download. */
  closurePackageDir?: string;
}

/** Fails closed when plugins are declared but closurePackageDir is absent — that pairing is a wiring bug. */
async function materializeSourcePluginFactories(
  deps: SidecarStepBuildEnvDeps,
  req: StepInvokeRequest,
): Promise<readonly AnnotatedPluginFactory[]> {
  const plugins = req.agent.plugins ?? [];
  if (plugins.length === 0) {
    return [];
  }
  if (deps.closurePackageDir === undefined) {
    throw new Error(
      `sidecar workflow-child step invoker: step agent ${JSON.stringify(req.agent.id)} declares plugins ${JSON.stringify(plugins)} but the source-ref closure package dir is absent; a source workflow's plugin factories can only be materialized from its frozen closure`,
    );
  }
  return loadWorkflowPluginFactoriesFromClosure({
    packageDir: deps.closurePackageDir,
    plugins,
  });
}

/** Pulled out of createSidecarSubstrateFactory so per-step env construction is observable in isolation. */
/** Absent when no credential material was threaded, leaving the step's inference reader and tool credentials unwired. */
interface SidecarStepCredentialContext {
  readonly materialCell: CredentialMaterialCell;
  /** Typed unknown[] at this boundary; the sidecar casts to GrantRule[] where the grammar is known. */
  readonly resolveStepGrants: (stepId: string) => readonly unknown[];
  readonly providers: CredentialProviderRegistry;
}

export function createSidecarStepBuildEnv(
  deps: SidecarStepBuildEnvDeps,
): (
  req: StepInvokeRequest,
  sourcesRef: SourcesSnapshotRef,
  credentialContext?: SidecarStepCredentialContext,
) => Promise<StepEnvBase> {
  return async (
    req: StepInvokeRequest,
    sourcesRef: SourcesSnapshotRef,
    credentialContext?: SidecarStepCredentialContext,
  ): Promise<StepEnvBase> => {
    // Resolved live each build; a warm agent already built doesn't pass
    // through here again, so this ref covers only builds not yet done.
    const resolveStepInferenceSource = createStepInferenceSourceResolver(sourcesRef.current);
    const { stepId, runId, attempt } = req.authzContext;
    if (stepId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.stepId is required for per-step InferenceSource resolution; the workflow runtime must populate stepId on every step-originated invocation",
      );
    }
    if (runId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.runId is required to root per-step storage under the run; the workflow runtime must populate runId on every step-originated invocation",
      );
    }
    if (attempt === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.attempt is required to root per-step storage per attempt; the workflow runtime must populate attempt on every step-originated invocation",
      );
    }
    const sources = resolveStepInferenceSource(stepId);
    // The resolver's arktype guarantees a non-empty chain; assert it here so
    // the reactor's initial-source pin (element 0) is a checked fact rather
    // than an unchecked index.
    const activeSource = sources[0];
    if (activeSource === undefined) {
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: empty InferenceSource chain pinned for stepId ${JSON.stringify(stepId)}`,
      );
    }

    // Cold path keys per run/step/attempt; warm path (durableConversation
    // present) keys stably per agent. Disjoint runs/ and warm/ sub-roots so
    // neither sweep touches the other's tree.
    const storeDir =
      deps.durableConversation !== undefined
        ? warmStepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId: deps.workflowRunRepoId,
            stepId,
          })
        : stepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId: deps.workflowRunRepoId,
            runId,
            stepId,
            attempt,
          });
    // The warm agent's conversation must survive child respawn, so it's
    // backed by a per-agent durable store mirrored to the substrate; a
    // multi-step deploy keeps the per-run isogit store instead.
    const storage: ContextStore & AuditStore =
      deps.durableConversation !== undefined
        ? (await deps.durableConversation.acquire(stepId)).storage
        : await createIsogitStore(storeDir, deps.signer);

    // Cold-path-only guard for the resume-attempt invariant on
    // stepStorageRoot: an approval resume must find a suspendedCall-bearing
    // pending op for its correlationId, or the runtime reopened the wrong
    // attempt's store and the reactor would hang (gateless) or silently
    // skip the approved call (matched only an async marker). Loud here at
    // the one seam that opened the store and knows the invariant.
    if (
      deps.durableConversation === undefined &&
      req.resume !== undefined &&
      req.resume.kind === "approval"
    ) {
      const resumeCorrelationId = req.resume.correlationId;
      const loaded = await storage.load();
      const hasPendingGate = loaded.pendingOperations.some(
        (op) => op.correlationId === resumeCorrelationId && op.suspendedCall !== undefined,
      );
      if (!hasPendingGate) {
        throw new Error(
          `sidecar workflow-child step invoker buildEnv: resume of step ${JSON.stringify(stepId)} (run ${JSON.stringify(runId)}, attempt ${String(attempt)}) reopened a ContextStore with no re-dispatchable approval gate for correlationId ${JSON.stringify(resumeCorrelationId)}. The cold-path store is keyed by attempt (${storeDir}); a resume that finds no suspendedCall-bearing pending operation here means it reopened the wrong attempt's store (the reactor would come up gateless and the decision would correlate against nothing) or matched only an async pending marker (the reactor would clear the gate without re-running the approved call). This is a keying violation, not a recoverable state.`,
        );
      }
    }

    const workdir = path.join(storeDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });

    // sourceTools: run the step agent's own evaluated toolFactories directly
    // (the source deploy stages no manifest, so materializeStepTools would
    // find nothing); plugin factories come separately from the frozen
    // closure into the same pluginFactories slot. Otherwise:
    // materializeStepTools loads the pinned tool-package closure, rooted
    // per step so concurrent steps never collide on cache/apply-state.
    const materialization: StepToolMaterialization =
      deps.sourceTools === true
        ? {
            factories: req.agent.toolFactories.map((factory) => ({
              packageName: factory.id,
              declaredCredentials: [],
              factory,
            })),
            pluginFactories: await materializeSourcePluginFactories(deps, req),
          }
        : await materializeStepTools({
            dataDir: deps.dataDir,
            mailboxAddress: deps.mailboxAddress,
            stepId,
            stepCount: deps.stepCount,
            storeDir,
            cache: deps.cache,
          });

    // A pinned tool never reached the hub's capability walk, so its floor is
    // recorded here for the grant evaluator; skipped on the source-ref
    // lineage since the walk already granted the bare tool name directly.
    if (deps.sourceTools !== true) {
      deps.recordToolMarkFloor(
        baseStepId(stepId),
        deriveToolMarkFloorGrants(materialization.factories.map((f) => f.factory)),
      );
    }

    // Outbound routes over control IPC to the supervisor for the actual
    // signed send; inbound (deps.inbound, warm agent only) resolves locally
    // against a fresh committed INBOX snapshot.
    const transport = createSupervisorBackedTransport(
      deps.outboundMailBridge,
      deps.mailboxAddress,
      deps.inbound,
    );

    const capabilities = createHarnessRuntimeCapabilities({ transport });

    // Widens StepEnvBase structurally (a wider object is assignable to the
    // narrower return type); address is observability-only.
    const env: StepEnvBase & {
      toolCwd: string;
      transport: MessageTransport;
      address: string;
      capabilities: RuntimeCapabilities;
    } = {
      // Pins the initial source to element 0 so the reactor fails over
      // forward through the full chain.
      sources,
      defaultSource: activeSource.id,
      storage,
      workdir,
      toolCwd: workdir,
      audit: storage,
      directors: createDefaultDirectorRegistry(),
      deps: createDependencies(deps.adapters),
      transport,
      address: deps.mailboxAddress,
      capabilities,
    };
    attachStepTools(env, materialization);
    // Grants are a thunk so a self-discovery resume preceding the grants
    // barrier doesn't fault on a missing snapshot.
    if (credentialContext !== undefined) {
      // Same live cell tool credentials resolve from, so the child never
      // holds the cipher key.
      env.readCurrentMaterial = createInferenceCredentialResolver(credentialContext.materialCell);
      attachStepCredentialWiring(env, {
        materialCell: credentialContext.materialCell,
        resolveGrants: () =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- resolveStepGrants returns unknown[] at the run-child boundary; the sidecar owns the GrantRule grammar
          credentialContext.resolveStepGrants(stepId) as readonly GrantRule[],
        providers: credentialContext.providers,
      });
    }
    return env;
  };
}

/** Widens StepInvoker with the child's authorize, its own per-spawn sourcesRef, and the parent's onEvent funnel. */
export type SidecarChildStepInvoker = (
  req: StepInvokeRequest,
  authorize: WorkflowAuthorizeFn,
  sourcesRef: SourcesSnapshotRef,
  onEvent: (event: InferenceEvent) => void,
  credentialContext?: SidecarStepCredentialContext,
) => Promise<StepInvokeResult>;

/**
 * Lifted out of createSidecarSubstrateFactory so it's exercisable in
 * isolation. The child runs with runId: childRunId, so its events land at
 * runs/<childRunId>/... sibling to the parent's own subtree, reusing the
 * parent's pack-pushing substrate and signing principal verbatim.
 */
interface SidecarRunChildDeps {
  /** Wrapped workflow-run substrate (the factory's `substrate`). */
  substrate: RepoStore;
  /** Workflow-run repo identifying the parent's deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run ref the child reads/writes against. */
  workflowRunRef: string;
  /** Principal the child presents on every substrate operation. */
  principal: Principal;
  /** Host-process scheduler singleton; shared with the parent. */
  scheduler: Scheduler;
  /**
   * The child's stepIds are disjoint from the parent's, so routing through
   * the parent's STEP_INFERENCE_SOURCES-pinned buildStepEnv would throw a
   * misleading error; callers supply a separate invokeStep instead.
   */
  invokeStep: SidecarChildStepInvoker;
  /** Keyed by definition id so the child never holds the sidecar cipher key; a missing id falls back to dataDir. */
  bodySources: BodyInferenceSources;
  /** Backs the legacy on-disk sources.json fallback and per-step storage roots. Required. */
  dataDir?: string;
  /** Supplied by the parent factory so the child authorizes against the same evaluator the parent's steps use. */
  evaluateGrants: GrantEvaluator;
  /** Combined with the run's live material cell and capped grants to assemble each bundle's credentials capability. */
  credentialProviders: CredentialProviderRegistry;
  /** Director registry the child runtime uses; defaults to the canonical built-ins. */
  directors?: DirectorRegistry;
  /** Present only on the source-ref lineage, to declare plugin-contributed tools when capping inherited grants. */
  closurePackageDir?: string;
  /** Clock for timestamp generation; defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Random id generator for run ids, signal ids, timer ids; defaults to
   * a monotonic counter combined with a random suffix.
   */
  newId?: (prefix: string) => string;
}

/**
 * Safe only because the sole caller is write-once, at the run's birth
 * before any event append — the shallow runs/<childRunId>/ prefix rebuild
 * would otherwise delete a populated run's events/blobs subtrees.
 */
async function writeChildRunGrants(args: {
  substrate: RepoStore;
  workflowRunRepoId: RepoId;
  principal: Principal;
  ref: string;
  childRunId: string;
  grants: readonly unknown[];
}): Promise<void> {
  const prefix = `runs/${args.childRunId}/`;
  const grantsFile = runGrantsPath(args.childRunId);
  const serialized = JSON.stringify({ grants: args.grants }, null, 2);
  await args.substrate.writeTreePreservingPrefix(args.principal, args.workflowRunRepoId, args.ref, {
    preservePrefix: prefix,
    merge: async (existing) => {
      const files: Record<string, string | Uint8Array> = {};
      for (const [k, v] of existing) files[k] = v;
      files[grantsFile] = serialized;
      return files;
    },
    message: `Write inherited run grants for ${args.childRunId}`,
  });
}

/**
 * No durable CancelRequested: an in-process child aborts through the
 * runtime's local-abort seam since it cannot sign the supervisor cancel a
 * control-plane cancel would require. The signal channel handle is
 * stop()ped in a finally block so no subscribeKind loop outlives the call.
 */
export function createSidecarRunChild(deps: SidecarRunChildDeps): RunChildWorkflow {
  const directors = deps.directors ?? createDefaultDirectorRegistry();
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? defaultNewId;
  // No controlPlanePrincipal: teardown goes through the local-abort seam, not
  // a durable CancelRequested. Shared across every child this factory spawns.
  const repoStore = createWorkflowRunRepoStore({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    ref: deps.workflowRunRef,
  });
  // Self-referential so a child env's recursive spawnChild routes
  // grandchild spawns back through this same adapter; recursion bottoms
  // out when a rung's definition has no childWorkflow primitive.
  const runChild: RunChildWorkflow = async (
    { definition, childRunId, input, parentRunId, signal, depth, maxChildSpawnDepth },
    onEvent,
    credentialMaterial,
  ) => {
    const {
      env,
      signalChannel,
      definition: rewrittenDefinition,
    } = await buildChildRunEnv({
      deps,
      directors,
      clock,
      newId,
      repoStore,
      runChild,
      definition,
      childRunId,
      parentRunId,
      onEvent,
      ...(credentialMaterial !== undefined ? { materialCell: credentialMaterial } : {}),
    });
    try {
      // Threads this rung's depth/ceiling so nested spawns keep counting
      // against the tree-wide bound rather than resetting to depth 0 per rung.
      // A parent abort tears down through the local-abort seam, not a
      // control-plane cancel the proxy substrate cannot sign.
      // `failed` under its own principal -- no durable cancel, no wedge while the
      // parent awaits the terminal below.
      const handle = runtimeRun(rewrittenDefinition, env, {
        runId: childRunId,
        triggerPayload: input,
        depth,
        maxChildSpawnDepth,
        localAbort: signal,
      });
      const result = await handle.complete;
      return { terminalStatus: result.terminalStatus };
    } finally {
      await signalChannel.stop();
    }
  };
  return runChild;
}

/**
 * Construct the `RunSuspendableChild` callback the suspendable-spawn
 * adapter delegates to. The park-aware analog of
 * {@link createSidecarRunChild}: instead of awaiting the child's terminal,
 * it returns a live {@link SuspendableChildHandle} the caller (`runOnTrigger`)
 * drives across the body's approval parks.
 *
 * Park surfacing: the built env's `onPark` sink translates the child body's
 * control-plane parks into the handle's `next()` stream. An `"approval"`
 * park is queued for the caller to proxy up on the same correlation; the
 * caller's granted decision returns through `resume`, which delivers it on
 * the child's own signal channel so the parked step unblocks. A body that
 * parks on a control-plane `"input"` channel is a nested onTrigger re-arm
 * the suspendable seam does not service -- the caller proxies approvals
 * only, so nothing would ever deliver that input and the child would park
 * forever. Rather than drop the park and hang, `onPark` surfaces it as a
 * hard error on `next()` and tears the child down locally so the section run
 * ends loudly (failed).
 *
 * Signal-channel lifecycle: unlike `createSidecarRunChild`, which stops the
 * channel in a `finally` around a single awaited terminal, this keeps the
 * channel alive across every park (so `resume` can deliver) and ties its
 * teardown to the run's terminal -- the one lifecycle moment every path
 * funnels through (normal completion, a parent-abort local teardown, an
 * illegal-input-park local teardown, or a runtime failure). Tearing down
 * per-`next()` would leak the channel when a parent abort makes `runOnTrigger`
 * stop calling `next()` mid-park.
 *
 * Abort propagation: the parent-supplied `signal` tears the body down through
 * `createSuspendableChildHandle`'s local-teardown seam -- the in-process body
 * runs under the `workflow-process` principal and cannot sign the control-plane
 * `CancelRequested` a durable cancel needs, so on abort its own step fails and
 * the run settles `failed` (not `cancelled`), and the terminal-tied teardown
 * runs.
 */
export function createSidecarSpawnSuspendableChild(deps: SidecarRunChildDeps): RunSuspendableChild {
  const directors = deps.directors ?? createDefaultDirectorRegistry();
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? defaultNewId;
  // No `controlPlanePrincipal`: an in-process body tears down through the shared
  // handle's local-abort seam (`createSuspendableChildHandle`), not a durable
  // `CancelRequested`, so it never writes a control-plane cancel this repo store
  // would have to sign. Run-body events use the workflow-process `principal`.
  const repoStore = createWorkflowRunRepoStore({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    ref: deps.workflowRunRef,
  });
  // A body's own `childWorkflow` grandchildren spawn terminal-only: the
  // suspendable seam is exercised only by onTrigger sections, and
  // `buildChildRunEnv` wires the body env's `spawnChild` (not
  // `spawnSuspendableChild`), so a nested onTrigger inside a body fails loud
  // rather than silently spawning.
  const runChild = createSidecarRunChild(deps);

  return async (
    {
      definition,
      childRunId,
      input,
      parentRunId,
      signal,
      depth,
      maxChildSpawnDepth,
      resumeFromEvents,
    },
    onEvent,
    credentialMaterial,
  ) => {
    const {
      env: baseEnv,
      signalChannel,
      definition: rewrittenDefinition,
    } = await buildChildRunEnv({
      deps,
      directors,
      clock,
      newId,
      repoStore,
      runChild,
      definition,
      childRunId,
      parentRunId,
      // The live event sink is always threaded (both a body step and a
      // grandchild childWorkflow step run a real agent). The body's own steps
      // and its childWorkflow grandchildren, built via the internal
      // `createSidecarRunChild(deps)` above, both run through the tool-bearing
      // `deps.invokeStep`.
      onEvent,
      // The run's live credential-material cell so the body's inference resolves
      // its source secret against the parent's current delivery; a grandchild
      // spawned from the body inherits it through the recursive spawnChild.
      ...(credentialMaterial !== undefined ? { materialCell: credentialMaterial } : {}),
    });

    return createSuspendableChildHandle(baseEnv, {
      definition: rewrittenDefinition,
      childRunId,
      input,
      depth,
      maxChildSpawnDepth,
      ...(resumeFromEvents !== undefined ? { resumeFromEvents } : {}),
      signal,
      cleanup: () => signalChannel.stop(),
    });
  };
}

/**
 * Read the parent run's grants, cap them to what `definition` declares, and
 * persist the capped set as the child run's own `runs/<childRunId>/grants.json`
 * -- the file the next spawn hop (a childWorkflow grandchild) reads back as its
 * ceiling. Returns the capped grants so a caller building a fresh child env can
 * also key its credentials snapshot on them.
 *
 * `definition` MUST be the PRE-rewrite body, its childWorkflow grandchildren
 * still INLINE: `collectDeclaredResources` skips a `{ ref }` body, so a
 * rewritten definition would drop the grandchild's declared resources and
 * under-authorize it. Every birth path materializes a run's grants file, so a
 * missing parent file is a defect, not a run that legitimately holds none --
 * fail closed. The cap only removes rules (the parent stays the ceiling),
 * matching the top level's "authority bounded by declared capabilities" model.
 *
 * The grants file is WRITE-ONCE per run: a run's authorization ceiling is fixed
 * at its birth, so this reads back an existing `runs/<childRunId>/grants.json`
 * rather than rewriting it. Re-writing on a resume re-drive is not just
 * redundant, it is CORRUPTING: `writeChildRunGrants` commits at the shallow
 * `runs/<childRunId>/` prefix through a substrate writer separate from the
 * runtime's event-log writer, so a re-write racing the runtime's replay
 * re-appends on the shared repo regresses another run's event seq (a
 * single-writer-invariant violation), and its wholesale subtree-delete drops the
 * run's committed `events/`/`blobs/` (the prefix read is non-recursive, so the
 * merge cannot carry them forward). The read-back returns the same capped set
 * the birth-time write persisted, so a fresh child-env caller keys its
 * credentials snapshot on identical grants either way.
 */
async function capAndPersistChildGrants(args: {
  deps: SidecarRunChildDeps;
  directors: ReturnType<typeof createDefaultDirectorRegistry>;
  definition: WorkflowDefinition;
  childRunId: string;
  parentRunId: string;
}): Promise<readonly unknown[]> {
  const { deps, directors, definition, childRunId, parentRunId } = args;
  const existingChildGrants = await readRunGrants({
    repoStore: deps.substrate,
    anchorRunId: deps.workflowRunRepoId.id,
    runId: childRunId,
  });
  if (existingChildGrants !== undefined) return existingChildGrants;
  const parentGrants = await readRunGrants({
    repoStore: deps.substrate,
    anchorRunId: deps.workflowRunRepoId.id,
    runId: parentRunId,
  });
  if (parentGrants === undefined) {
    throw new Error(
      `sidecar runChild: parent run ${parentRunId} has no grants file at ${runGrantsPath(parentRunId)}; refusing to spawn child ${childRunId} under-authorized`,
    );
  }
  const pluginDefs: PluginToolDefinitions =
    deps.closurePackageDir === undefined
      ? new Map()
      : await loadWorkflowPluginToolDefinitionsFromClosure({
          packageDir: deps.closurePackageDir,
          plugins: collectDeclaredPluginNames(definition),
        });
  const declaredResources = collectDeclaredResources(definition, directors, pluginDefs);
  const childGrants = filterGrantsToDeclaredResources(parentGrants, declaredResources);
  await writeChildRunGrants({
    substrate: deps.substrate,
    workflowRunRepoId: deps.workflowRunRepoId,
    principal: deps.principal,
    ref: deps.workflowRunRef,
    childRunId,
    grants: childGrants,
  });
  return childGrants;
}

/**
 * Build the per-childRunId `WorkflowRuntimeEnv` a spawned child runs
 * against: inherit the parent's grants, assemble the child's credentials
 * snapshot, and wire the per-run repo store / blob substrate / signal
 * channel plus a recursive `spawnChild`. Returned alongside the child's
 * signal channel so the caller can `stop()` it once the child settles.
 * Shared by the child-drive callers so the env construction lives in one
 * place.
 */
async function buildChildRunEnv(args: {
  deps: SidecarRunChildDeps;
  directors: ReturnType<typeof createDefaultDirectorRegistry>;
  clock: () => Date;
  newId: (prefix: string) => string;
  repoStore: ReturnType<typeof createWorkflowRunRepoStore>;
  runChild: RunChildWorkflow;
  definition: WorkflowDefinition;
  childRunId: string;
  parentRunId: string;
  /** Required for both paths (childWorkflow and onTrigger body); a missing sink is a wiring defect, not a silent drop. */
  onEvent: (event: InferenceEvent) => void;
  /** Absent when a non-sidecar executor carries no credential material, leaving the child's inference reader unset. */
  materialCell?: CredentialMaterialCell;
}): Promise<{
  env: WorkflowRuntimeEnv;
  signalChannel: ReturnType<typeof createWorkflowHostSignalChannel>;
  definition: WorkflowDefinition;
}> {
  const {
    deps,
    directors,
    clock,
    newId,
    repoStore,
    runChild,
    definition,
    childRunId,
    parentRunId,
    onEvent,
    materialCell,
  } = args;
  // Lifts each inline grandchild childWorkflow to a { ref } and keeps the
  // lifted definitions in-memory, so a grandchild spawns with no on-disk read.
  const { workflow: rewrittenDefinition, bodies: grandchildBodies } =
    rewriteInlineChildWorkflowBodies(definition);
  const grandchildMap = new Map(grandchildBodies.map((b) => [b.ref, b.definition]));
  // Mints a ref-keyed copy for the loop-iteration host and keeps the
  // pre-rewrite form for the per-iteration grant cap. Mirrors the
  // top-level loop-body registration in run-child.ts.
  const loopBodies = enumerateInlineLoopBodies(definition);
  const loopBodiesMap = new Map<string, WorkflowDefinition>();
  const loopBodyPreRewrite = new Map<string, WorkflowDefinition>();
  for (const loopBody of loopBodies) {
    loopBodyPreRewrite.set(loopBody.ref, loopBody.definition);
    const bodyRewrite = rewriteInlineChildWorkflowBodies(loopBody.definition);
    loopBodiesMap.set(loopBody.ref, bodyRewrite.workflow);
    for (const grandchild of bodyRewrite.bodies) {
      grandchildMap.set(grandchild.ref, grandchild.definition);
    }
  }
  // A loop declared with no closure wired is a wiring defect; fail loud
  // rather than deferring to a mid-run resolve failure.
  let loopFns: LoopFnRegistry | undefined;
  if (loopBodies.length > 0) {
    if (deps.closurePackageDir === undefined) {
      throw new Error(
        "sidecar child: a loop is nested in this spawned body but deps.closurePackageDir is missing; the loop while/carry fns cannot be resolved",
      );
    }
    loopFns = await loadWorkflowLoopFnsFromClosure({
      packageDir: deps.closurePackageDir,
    });
    eagerlyResolveLoopFns(
      [rewrittenDefinition, ...loopBodiesMap.values(), ...grandchildMap.values()],
      loopFns,
    );
  }
  // Persisted as runs/<childRunId>/grants.json, the file a grandchild reads as its ceiling.
  const childGrants = await capAndPersistChildGrants({
    deps,
    directors,
    definition,
    childRunId,
    parentRunId,
  });
  // The in-process child has no per-step mail address, so address mirrors
  // the step id (createCredentialsBackedAuthorize reads only grants). Walks
  // past stepOrder into loop bodies too, or a nested loop's authorize would
  // throw on its first tool call for lacking a snapshot entry.
  const credentialStepIds = new Set<string>();
  walkWorkflowSteps({
    definition: rewrittenDefinition,
    descent: LOOP_BODY_DESCENT,
    context: "sidecar child credentials snapshot: ",
    visit: ({ stepId }) => {
      credentialStepIds.add(stepId);
    },
  });
  const contentHash = await hashGrants(childGrants);
  const credentialsSnapshot: CredentialsSnapshot = {
    steps: [...credentialStepIds].map((stepId) => ({
      stepId,
      address: stepId,
      grants: childGrants,
      contentHash,
    })),
  };
  const blobs = createWorkflowRunBlobSubstrate({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    runId: childRunId,
    ref: deps.workflowRunRef,
  });
  const signalChannel = createWorkflowHostSignalChannel({
    repoStore: deps.substrate,
    principal: deps.principal,
    repoId: deps.workflowRunRepoId,
    ref: deps.workflowRunRef,
    runId: childRunId,
    readState: () => emptyState(childRunId),
    newId: () => newId("sig"),
    clock,
  });
  // Each (resource, action) decision looks up the step's grants and
  // delegates to the parent factory's grant evaluator.
  const credentialsRef: CredentialsSnapshotRef = {
    current: credentialsSnapshot,
  };
  const authorize = createCredentialsBackedAuthorize(credentialsRef, deps.evaluateGrants);
  const drain = createNoopDrainController(rewrittenDefinition);
  // Required for both childWorkflow and onTrigger body paths; a missing
  // one is a wiring defect, not a silent drop.
  if (onEvent === undefined) {
    throw new Error(
      "sidecar child: onEvent is missing; child inference events would be silently dropped from the hub stream",
    );
  }
  const childOnEvent = onEvent;
  // Disjoint from the top-level's mutable table, so a source rotation there
  // never leaks into a child; sources arrive plaintext, decrypted sidecar-side.
  const sourcesRef: SourcesSnapshotRef = {
    current: await resolveBodyStepSources(deps, rewrittenDefinition.id),
  };
  // Mirrors the rung-0 wrap in run-child.ts so a grandchild's agent steps
  // ride this run's event channel.
  const spawnHost = createInMemorySpawnChild({
    bodies: grandchildMap,
    runChild,
  });
  const spawnChild: WorkflowRuntimeEnv["spawnChild"] = (spawnInput) =>
    spawnHost(spawnInput, childOnEvent, materialCell);
  // Absent when no material was threaded (a non-sidecar executor), leaving
  // the child's inference reader unset.
  const childCredentialContext: SidecarStepCredentialContext | undefined =
    materialCell === undefined
      ? undefined
      : {
          materialCell,
          resolveStepGrants: (stepId) => {
            const entry = credentialsSnapshot.steps.find(
              (step) => step.stepId === baseStepId(stepId),
            );
            if (entry === undefined) {
              throw new Error(
                `sidecar child credential wiring: credentials snapshot has no entry for step ${baseStepId(stepId)}`,
              );
            }
            return entry.grants;
          },
          providers: deps.credentialProviders,
        };
  // One invoker serves both the childWorkflow and onTrigger body paths.
  const invokeStep: WorkflowRuntimeEnv["invokeStep"] = (req) =>
    deps.invokeStep(req, authorize, sourcesRef, childOnEvent, childCredentialContext);
  const env: WorkflowRuntimeEnv = {
    repoStore,
    scheduler: deps.scheduler,
    signalChannel,
    blobs,
    directors,
    authorize,
    invokeStep,
    spawnChild,
    clock,
    newId,
    drain,
    ...(loopFns !== undefined ? { loopFns } : {}),
  };
  // Assigned after the env literal since the iteration host closes over env.
  // Deliberately replicates the top-level loop host in run-child.ts rather
  // than sharing a helper — extract one only once a deployed loop-in-body
  // resume test shows the two paths match. The suspendable-child seam
  // services approval parks only.
  if (loopFns !== undefined) {
    const loopIterationHost = createInMemorySpawnSuspendableChild({
      bodies: loopBodiesMap,
      runSuspendableChild: async (loopInput, _onEvent) => {
        const preRewriteBody = loopBodyPreRewrite.get(loopInput.definitionRef);
        if (preRewriteBody === undefined) {
          throw new Error(
            `sidecar child: no pre-rewrite loop body for ref ${loopInput.definitionRef}`,
          );
        }
        // Capped against the body's own grants before the first event.
        await capAndPersistChildGrants({
          deps,
          directors,
          definition: preRewriteBody,
          childRunId: loopInput.childRunId,
          parentRunId: loopInput.parentRunId,
        });
        const iterationSignalChannel = createWorkflowHostSignalChannel({
          repoStore: deps.substrate,
          principal: deps.principal,
          repoId: deps.workflowRunRepoId,
          ref: deps.workflowRunRef,
          runId: loopInput.childRunId,
          readState: () => emptyState(loopInput.childRunId),
          newId: () => newId("sig"),
          clock,
        });
        return createLoopIterationHandle(env, {
          definition: loopInput.definition,
          childRunId: loopInput.childRunId,
          input: loopInput.input,
          depth: loopInput.depth,
          maxChildSpawnDepth: loopInput.maxChildSpawnDepth,
          ...(loopInput.resumeFromEvents !== undefined
            ? { resumeFromEvents: loopInput.resumeFromEvents }
            : {}),
          signal: loopInput.signal,
          signalChannel: iterationSignalChannel,
          cleanup: () => iterationSignalChannel.stop(),
        });
      },
    });
    env.spawnLoopIteration = (spawnInput) => loopIterationHost(spawnInput, childOnEvent);
  }
  return { env, signalChannel, definition: rewrittenDefinition };
}

/**
 * Legacy fallback: a body absent from deps.bodySources (a record predating
 * body sources moving into the record) reads its plaintext on-disk
 * sources.json instead. Removable once no restorable record predates it.
 */
async function resolveBodyStepSources(
  deps: SidecarRunChildDeps,
  definitionId: string,
): Promise<StepInferenceSourceTable> {
  const delivered = deps.bodySources[definitionId];
  if (delivered !== undefined) {
    return delivered;
  }
  if (deps.dataDir === undefined) {
    throw new Error(
      `sidecar child: body ${definitionId} is absent from the delivered sources and deps.dataDir is missing, so its legacy on-disk sources cannot be read`,
    );
  }
  return readChildStepInferenceSources(deps.dataDir, definitionId);
}

/** See resolveBodyStepSources; only reached for a body the delivered set doesn't carry. */
async function readChildStepInferenceSources(
  dataDir: string,
  childRef: string,
): Promise<StepInferenceSourceTable> {
  const sourcesPath = path.join(dataDir, "assets", "workflow", childRef, "sources.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(sourcesPath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar child: failed to read child inference sources at ${sourcesPath}: ${reason}`,
      { cause },
    );
  }
  return parseStepInferenceSources(raw);
}

function defaultClock(): Date {
  return new Date();
}

let runChildIdCounter = 0;
function defaultNewId(prefix: string): string {
  runChildIdCounter += 1;
  return `${prefix}-${String(runChildIdCounter)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Opens a bare RepoStore for read-only operations against the shared
 * on-disk workflow-run repo, then a proxy RepoStore whose writes forward
 * over the control channel into the supervisor's own (pack-push-wrapped)
 * substrate.
 */
export function createSidecarSubstrateFactory(
  deps: SidecarSubstrateFactoryDeps = {},
): SubstrateFactory {
  const createBareRepoStore =
    deps.createBareRepoStore ??
    (({ dataDir, signingKey }) => createAgentRepoStore({ dataDir, signingKey }).repoStore);

  return async (env: SubstrateFactoryEnv) => {
    const validated = SubstrateConfig(env.substrateConfig);
    if (validated instanceof type.errors) {
      throw new Error(
        `sidecar workflow-child substrate config failed validation: ${validated.summary}`,
      );
    }

    const stepInferenceSources = parseStepInferenceSources(validated.STEP_INFERENCE_SOURCES);

    // Eager: a bad specifier crashes the child loudly at construction
    // rather than silently degrading to built-ins-only at first resolve.
    const childAdapterRegistry = await loadAdapterRegistry(
      parseAdapterManifest(validated.SIDECAR_ADAPTER_MANIFEST),
    );

    const signingKey = {
      publicKey: hexDecode(validated.SIDECAR_SIGNING_PUBLIC_KEY, "SIDECAR_SIGNING_PUBLIC_KEY"),
      privateKey: hexDecode(validated.SIDECAR_SIGNING_PRIVATE_KEY, "SIDECAR_SIGNING_PRIVATE_KEY"),
    };

    const bareStore: RepoStore = createBareRepoStore({
      dataDir: validated.SIDECAR_DATA_DIR,
      signingKey,
    });

    const workflowRunRepoId = {
      kind: "workflow-run" as const,
      id: validated.WORKFLOW_RUN_REPO_ID,
    };
    const principal: WorkflowRunWorkflowProcessPrincipal = {
      kind: "workflow-process",
      anchorRunId: env.spawn.anchorRunId,
    };

    // Proxy substrate: writes are forwarded over IPC into the
    // supervisor's substrate; reads consult the bare on-disk store.
    // The supervisor is the sole writer of the workflow-run ref so
    // the child's writes never race against the supervisor's
    // claim-check writes (inbox / processing / consumed).
    const substrate: RepoStore = createProxyWorkflowRunRepoStore({
      bareStore,
      bridge: env.substrateWriteBridge,
      workflowRunRepoId,
    });

    // INBOUND half of mailbox ownership (§3b). One watch registry per child,
    // created at boot and shared by BOTH the step agent's supervisor-backed
    // transport (its `watch` registers callbacks here, backing `mail_wait`) and
    // the child's control loop (which fires each `mailbox.notify` into it). The
    // registry rides out on the returned bindings so `runWorkflowChild` routes
    // notifications to this same instance. The child mailbox reader opens a
    // fresh committed snapshot of the deployment's substrate `INBOX` per read,
    // over the same substrate handle / repo id / principal / ref the mail-part
    // reader uses, so a read taken after a `mailbox.notify` observes the message
    // the supervisor just committed.
    const mailboxWatchRegistry = createMailboxWatchRegistry();
    const transportInbound: SupervisorBackedTransportInbound = {
      reader: createChildMailboxReader({
        substrate,
        repoId: workflowRunRepoId,
        principal,
        ref: validated.WORKFLOW_RUN_REF,
      }),
      watchRegistry: mailboxWatchRegistry,
      // The child holds no sender-key registry, so signature verification is not
      // yet possible here; `fetchFull` reports every message's signature status
      // as "unknown". A future sender-key surface would replace this resolver.
      getCrypto: () => undefined,
      // The write methods (setFlags / clearFlags / expunge) route through this
      // bridge to the supervisor, the sole mailbox writer, instead of flushing
      // the run ref from the child.
      mutationBridge: env.mailboxMutationBridge,
    };

    const hostScheduler = createWorkflowHostScheduler({
      repoStore: substrate,
      principal,
      listActiveDeployments: () => [workflowRunRepoId],
      ref: validated.WORKFLOW_RUN_REF,
      clock: () => new Date(),
    });
    await hostScheduler.start();
    const scheduler = adaptHostScheduler(hostScheduler);

    // The single-step / top-level path runs a real agent. The per-step
    // env builder stands up real per-step storage/workdir/audit/directors
    // rooted under the run (see `createSidecarStepBuildEnv`), resolving
    // the per-step `InferenceSource` from the pinned table; the real
    // step-invoker instantiates the step's agent via `createAgent`,
    // delivers the resolved input as a synthesized inbound message, and
    // captures the agent's reply as the step output.
    const stepToolCache: StepToolCacheConfig = {
      cacheMaxBytes: parseByteCap(validated.SIDECAR_CACHE_MAX_BYTES, "SIDECAR_CACHE_MAX_BYTES"),
      registryMaxTarballBytes: parseByteCap(
        validated.SIDECAR_REGISTRY_MAX_TARBALL_BYTES,
        "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
      ),
    };

    // The single-step / top-level path runs a real agent with REAL
    // tools materialized in-child. The per-step env builder stands up
    // real per-step storage/workdir/audit/directors rooted under the
    // run (see `createSidecarStepBuildEnv`), resolves the per-step
    // `InferenceSource`, and materializes the step's pinned
    // tool-package closure (posix, LSP, mail, ...) from its on-disk
    // deploy tree -- rooted per step so concurrent steps in one child
    // never collide on the tarball cache or apply-state. The
    // tool-bearing `agentFactory` below attaches those factories to the
    // step's `AgentDefinition` and builds the plugin chain.
    // Durable-conversation registry for the warm single-step agent
    // (design §3c). Built only when the deployment is warm-kept: the
    // sole long-lived agent's conversation must survive child respawn,
    // so it is mirrored to the workflow-run substrate at a per-agent
    // path. A multi-step deploy leaves this `undefined` -- its per-step
    // agents are not warm/long-lived (§3b), so they carry no cross-run
    // conversation and keep the per-run isogit store. The registry lives
    // for the child's lifetime; on respawn the child rebuilds it empty
    // and each store restores its prior snapshot from the substrate on
    // first acquire.
    const conversationSigner = createStepStorageSigner(signingKey);
    const durableConversation: DurableConversationRegistry | undefined = env.spawn.warmKeep
      ? createDurableConversationRegistry({
          dataDir: validated.SIDECAR_DATA_DIR,
          workflowRunRepoId,
          workflowRunRef: validated.WORKFLOW_RUN_REF,
          substrate,
          principal,
          signer: conversationSigner,
        })
      : undefined;

    // Per-step tool-mark floor grants, keyed by base step id. The step
    // env builder derives and records each step's floor from its
    // materialized (pinned) tool factories; the grant evaluator reads it
    // by base step id and merges it under the credentials snapshot's
    // grants so a pinned tool authorizes against its own static mark. The
    // map lives for the factory's (child's) lifetime, so a warm agent's
    // floor -- recorded on its single first build -- remains available
    // for every later tool call it makes.
    const toolMarkFloorByStep = new Map<string, GrantRule[]>();

    const buildStepEnv = createSidecarStepBuildEnv({
      dataDir: validated.SIDECAR_DATA_DIR,
      workflowRunRepoId,
      signer: conversationSigner,
      mailboxAddress: env.spawn.mailboxAddress,
      stepCount: env.spawn.stepCount,
      outboundMailBridge: env.outboundMailBridge,
      cache: stepToolCache,
      adapters: childAdapterRegistry,
      recordToolMarkFloor: (stepId, grants) => {
        toolMarkFloorByStep.set(stepId, grants);
      },
      // Source-ref is the only deploy lineage: the child runs each step agent's
      // own evaluated tool factories (fed from `req.agent.toolFactories`) from
      // the materialized closure, never a pinned tool-package manifest off a
      // deploy tree.
      sourceTools: true,
      // The materialized closure dir the source arm materializes each step
      // agent's declared plugin packages from. Always present (source-ref only).
      closurePackageDir: env.spawn.closurePackageDir,
      // Activate the warm agent's inbound mail surface: `mail_read` /
      // `mail_search` / `mail_wait` resolve against the deployment's committed
      // substrate `INBOX` through this bundle. The spawned-child build below
      // omits it (a spawned child owns no warm inbound mailbox).
      inbound: transportInbound,
      ...(durableConversation !== undefined ? { durableConversation } : {}),
    });

    // The tool-bearing agent factory reads the materialized tool
    // runtime off the per-step env (set by `buildStepEnv` via
    // `attachStepTools`), attaches the loaded tool factories to the
    // step's `AgentDefinition`, builds the plugin chain on
    // `env.plugins`, and wraps `agent.close()` so every plugin (the LSP
    // subprocess included) and tool bundle is torn down with the agent
    // on every exit path. The factory is stateless across steps, so it
    // is pinned once here and shared by every per-step invoker built
    // below.
    const stepAgentFactory = createToolBearingAgentFactory();

    // The credential provider registry that shapes a delivered credential into
    // a mediated handle. Built once here from the sidecar-static built-ins (the
    // origin-pinned http provider) plus the header-shaped presets
    // (`@corbits/credential-header`, for a provider row whose API expects
    // the raw secret in `authorization` or an `x-api-key` header instead of
    // a Bearer-prefixed `authorization`) and the MCP streamable-HTTP
    // provider (`@corbits/credential-mcp`, for a tenant-connected MCP
    // server, including its keyless-connection sentinel) — shared by every
    // per-step build; the per-run material and grants ride in separately at
    // each invoke.
    const credentialProviders = createCredentialProviderRegistry([
      ...builtinCredentialProviders(),
      xApiKeyCredentialProvider(),
      rawAuthorizationCredentialProvider(),
      createMcpStreamableHttpCredentialProvider(),
    ]);

    // Spawned-child step build env (INTR-310). Every spawned child's steps --
    // a childWorkflow child's and an onTrigger section body's alike -- run real,
    // TOOL-BEARING agents through the same source-tools arm the top level uses:
    // the child holds the live re-verified definition, so each step agent
    // carries live `toolFactories` fed from `req.agent.toolFactories`, and the
    // source arm materializes declared plugins from the shared closure. Tools
    // are available wherever inference runs, so a body agent gets the same
    // build a top-level step agent gets (see the tool-availability invariant in
    // `packages/workflow/README.md`).
    //
    // Built COLD per invocation -- no `durableConversation`/warm hooks (a
    // fan-out branch and a section body are each a fresh run per spawn) and no
    // `inbound` (a spawned child owns no warm inbound mailbox; inbound-reading
    // tools stay inert). The source arm records no tool-mark floor (a source
    // tool's bare `tool:<name>` grant is already in the credentials snapshot),
    // so the floor recorder throw-asserts that invariant.
    //
    // The source arm also keeps the body's tools scoped correctly by
    // construction: a body child runs under the PARENT deployment's
    // `mailboxAddress`/`stepCount`, so a body step whose id collides with a
    // parent step id would read the PARENT step's tools if tools were resolved
    // off the deploy tree. Feeding each agent its own evaluated
    // `req.agent.toolFactories` never consults that tree.
    const coldChildBuildStepEnv = createSidecarStepBuildEnv({
      dataDir: validated.SIDECAR_DATA_DIR,
      workflowRunRepoId,
      signer: conversationSigner,
      mailboxAddress: env.spawn.mailboxAddress,
      stepCount: env.spawn.stepCount,
      outboundMailBridge: env.outboundMailBridge,
      cache: stepToolCache,
      adapters: childAdapterRegistry,
      recordToolMarkFloor: () => {
        throw new Error("source-tools child build-env must not record a tool-mark floor");
      },
      sourceTools: true,
      closurePackageDir: env.spawn.closurePackageDir,
    });
    // Spawned-child step invoker (INTR-310). It runs a real agent through
    // `createWorkflowStepInvoker`, resolving inference against the child's own
    // per-step `sourcesRef` (staged at deploy, read fresh per spawn) and
    // funnelling live events to the parent run's channel. `buildChildRunEnv`
    // threads in the run's `credentialContext` (the live material cell, the
    // child's capped grants, the sidecar-static providers), so the build
    // attaches each bundle's `credentials` capability and the step's inference
    // resolves its source secret against the run's live material. Absent when no
    // material was threaded, in which case a tool that declares a credential
    // consumer fails closed and loud at its own `resolve("credentials")`, never
    // silently. Wired as `childRunDeps.invokeStep`, so it covers every spawned
    // child's steps: a childWorkflow child, an onTrigger section body, and a
    // body's own childWorkflow grandchildren.
    const childInvokeStep: SidecarChildStepInvoker = (
      req,
      authorize,
      sourcesRef,
      onEvent,
      credentialContext,
    ) =>
      createWorkflowStepInvoker({
        workflowAuthorize: authorize,
        buildEnv: (buildReq) => coldChildBuildStepEnv(buildReq, sourcesRef, credentialContext),
        agentFactory: stepAgentFactory,
        sourcesRef,
        onEvent,
      })(req);

    // Adapt the workflow-runtime `StepInvoker` shape onto the host's
    // `ChildStepInvoker` shape. The host's `onEvent` is the child's
    // per-run event-channel sink: the runtime body passes it per step,
    // and the chain from here is `onEvent -> child event-channel sender
    // -> supervisor -> publishWorkflowInferenceEvent -> hub timeline`.
    //
    // The `authorize` argument is the child's credentials-backed
    // authorize closure (`createCredentialsBackedAuthorize`), threaded
    // in from `run-child.ts`'s runtime env. The step agent's runtime
    // gates EVERY tool call through `env.authorize` with
    // `resource = tool:<name>`, `action = "invoke"` (the inference
    // layer's authz before-tool extension); using the credentials-backed
    // authorize here means each tool call resolves against the per-step
    // grant snapshot the supervisor assembled from the agent's
    // `state/grants.json` and pushed over the control IPC. A tool the
    // agent's grants do not allow is blocked; a granted tool runs. The
    // operator gate at deploy time (the capability walk's `tool:<name>`
    // approval) and this runtime grant check are complementary: the walk
    // bounds the toolset the deploy may carry, the grant snapshot decides
    // which of those the agent may invoke at run time.
    //
    // A fresh `createWorkflowStepInvoker` is built per invocation so the
    // adapter subscribes the step agent's event stream to THIS step's
    // `onEvent`. The per-step env builder and the tool-bearing agent
    // factory are pinned (closed over above); the event sink and the
    // authorize closure vary per step.
    //
    // The `warmCache` (design §3b) is the run-loop's per-deployment
    // warm-agent cache, present only for the single-step long-lived
    // deployment the deploy projection marked a warm candidate. When
    // supplied, the adapter builds the agent once and reuses it across
    // messages; when absent, it keeps instantiate-send-teardown per
    // step. Forwarding it here is the only warm-keep wiring this binding
    // needs -- the adapter and the run-loop own the rest of the
    // lifecycle.
    // Run-boundary durability flush (design §3c). When the deployment is
    // warm-kept, mirror the warm agent's conversation snapshot to the
    // workflow-run substrate after each message's send settles. The key
    // is the step identity, the same key the env builder filed the
    // durable store under, so the hook resolves the right per-agent
    // store. Absent for a multi-step deploy (no durable registry).
    const onRunBoundary: ((key: string) => Promise<void>) | undefined =
      durableConversation !== undefined
        ? async (key: string) => {
            await durableConversation.get(key).mirrorToSubstrate();
          }
        : undefined;

    // Connector-thread seed (design §3c). When the deployment is warm-kept,
    // route each mail-derived inbound message onto the warm agent's
    // connector thread before its send, so the reply path has thread state.
    // The key is the step identity, the same key the durable store is filed
    // under. Absent for a multi-step deploy (no durable registry).
    const seedInbound: ((key: string, message: InboundMessage) => Promise<void>) | undefined =
      durableConversation !== undefined
        ? async (key: string, message: InboundMessage) => {
            await durableConversation.get(key).seedInbound(message);
          }
        : undefined;

    // Connector reply drain (design §3c). When the deployment is
    // warm-kept, drive the warm agent's outbound replies through the shared
    // connector reply drain: on each `connector.reply` the agent emits,
    // compose a threaded reply from the durable store's connector thread,
    // send it through the outbound bridge (`bridge.submit`, the same signed-
    // send path the agent's own supervisor-backed transport uses), then
    // advance the thread from the receipt. Established once per warm agent
    // over its lifetime stream; the returned drain handle carries the lifetime
    // `done` promise the step-invoker folds into the warm entry so eviction
    // drains it, plus the per-turn settle barrier the warm step gates each
    // reply turn on. The key is the step identity, the same key the durable
    // store is filed under. Absent for a multi-step deploy (no durable
    // registry).
    const driveReplies:
      | ((key: string, stream: AgentEventStream) => ConnectorReplyDrain)
      | undefined =
      durableConversation !== undefined
        ? (key: string, stream: AgentEventStream) =>
            driveConnectorReplies({
              stream,
              composeReply: () => durableConversation.get(key).composeReply(),
              send: (message) => env.outboundMailBridge.submit(env.spawn.mailboxAddress, message),
              // Build the full RFC 5322 References chain from the deployment's
              // committed mailbox: locate the parent by its Message-Id and
              // return its own References plus its Message-Id, so a reply
              // carries the whole conversational ancestry rather than a
              // single element. The reader opens a fresh committed snapshot,
              // so a parent committed just before this reply is visible. A
              // parent miss (the first reply on a fresh thread, a malformed
              // id) returns undefined and the transport derives [inReplyTo].
              resolveReferences: (inReplyTo) =>
                resolveMailboxReferences(transportInbound.reader, inReplyTo),
              onReplySent: (receipt) => durableConversation.get(key).onReplySent(receipt),
            })
        : undefined;

    const invokeStep: RunWorkflowChildBindings["invokeStep"] = async (
      req,
      onEvent,
      authorize,
      warmCache,
      sourcesRef,
      credentialWiring,
      mailPartReader,
    ) =>
      createWorkflowStepInvoker({
        workflowAuthorize: authorize,
        // Combine the per-run credential wiring (the live material cell and
        // the step-grants resolver, ridden in from the run child) with the
        // sidecar-static provider registry, so `buildStepEnv` attaches a
        // complete credential context and the agentFactory can assemble each
        // bundle's consumer-scoped `credentials` capability.
        buildEnv: (buildReq) =>
          buildStepEnv(buildReq, sourcesRef, {
            materialCell: credentialWiring.materialRef,
            resolveStepGrants: credentialWiring.resolveStepGrants,
            providers: credentialProviders,
          }),
        agentFactory: stepAgentFactory,
        onEvent,
        sourcesRef,
        mailPartReader,
        ...(warmCache !== undefined ? { warmCache } : {}),
        ...(onRunBoundary !== undefined ? { onRunBoundary } : {}),
        ...(seedInbound !== undefined ? { seedInbound } : {}),
        ...(driveReplies !== undefined ? { driveReplies } : {}),
      })(req);

    const evaluateGrantsAdapter: GrantEvaluator = async ({ resource, action, stepId, grants }) => {
      // Merge the step's pinned-tool floor grants (derived and recorded
      // by the env builder from the step's materialized factories) under
      // the credentials snapshot's grants. The floor supplies the
      // `tool:<name>` authority a pinned tool never got from the hub's
      // capability walk. It is ADDITIVE: `evaluateGrants` ranks by
      // specificity then effect, so a declared `deny` (priority 2) still
      // beats the derived `ask`/`allow` and an explicit denial is
      // honored -- the floor only raises the minimum authority to the
      // tool's static mark.
      //
      // A missing floor entry (`?? []`) contributes no rows: this can
      // only ever fail MORE closed (a pinned tool the hub also did not
      // grant stays denied, the pre-#68 behavior), never open a hole, so
      // it is safe as an additive default. The floor is keyed by base
      // step id, so a `map` iteration's scoped id resolves to its base
      // step's floor.
      const floor = toolMarkFloorByStep.get(baseStepId(stepId)) ?? [];
      const result = await evaluateGrants(
        // The credentialsSnapshot's grants are typed as
        // `readonly unknown[]` so the workflow-host package does not
        // depend on the sidecar's grant-rule grammar. The sidecar owns
        // that grammar; the cast surfaces here at the boundary where
        // the typed grant shape is known.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- credentialsSnapshot.steps[*].grants is typed unknown[] at the workflow-host boundary; the sidecar owns the GrantRule grammar
        [...(grants as readonly GrantRule[]), ...floor],
        resource,
        action,
      );
      return {
        effect: result.effect,
        matchingGrants: [],
        resolvedBy: null,
      };
    };

    const childRunDeps: SidecarRunChildDeps = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      principal,
      scheduler,
      invokeStep: childInvokeStep,
      // Plaintext body sources decrypted sidecar-side from the run record; each
      // body path resolves its own table from here by definition id.
      bodySources: parseBodyInferenceSources(validated.WORKFLOW_BODY_SOURCES),
      dataDir: validated.SIDECAR_DATA_DIR,
      evaluateGrants: evaluateGrantsAdapter,
      // Shared with the top level's `buildStepEnv`: a spawned child's build
      // combines it with the run's live material and capped grants.
      credentialProviders,
      // The shared closure the child re-walks to cap its inherited grants at
      // its declared capabilities. Source-ref only, so always present here.
      closurePackageDir: env.spawn.closurePackageDir,
    };
    // Terminal childWorkflow executor. `run-child` builds the in-memory
    // resolver from this plus the lifted-body map it extracts after loading
    // the parent's re-verified definition, so an owned inline child spawns
    // with no on-disk asset read.
    const runChild = createSidecarRunChild(childRunDeps);

    // An onTrigger section runs each event's body as a suspendable child.
    // Source-ref is the only deploy lineage: `run-child` builds the in-memory
    // body resolver from this raw executor plus the lifted-body map it extracts
    // after re-evaluating the parent's closure, so a body resolves in-process
    // with no on-disk read and no separate per-body re-verify (the parent's
    // re-verify already covers every inline body).
    const runSuspendableChild = createSidecarSpawnSuspendableChild(childRunDeps);

    // Per-run scratch reclamation for the cold (multi-step) path. The
    // run-loop fires this once each run reaches its terminal status; it
    // drops the run's whole `workflow-step-state/<repoId>/runs/<runId>/`
    // subtree (every step/attempt the run produced), which nothing
    // reopens after terminal (resume reads the substrate run log, not
    // local step state).
    //
    // Parked-step safety: reclamation keys on the RUN's terminal status,
    // and a step parked on a signal (`awaiting-signal`) keeps the run
    // non-terminal, so this never fires while a suspended step's
    // `attempt-N` store still holds a live pending-op the resume path must
    // reopen. Any future per-STEP reclamation must preserve that invariant
    // -- it MUST exclude an `awaiting-signal` step, whose `attempt-N` store
    // is the exact store a later crash-resume reopens to rehydrate the
    // gate; dropping it would reproduce the empty-store hang the
    // resume-attempt recovery closes.
    //
    // Built only for the cold path: a warm deploy
    // roots its single agent's scratch per agent under the disjoint
    // `warm/` sub-root (reclaimed on undeploy), and the run-loop's own
    // `warmKeep` gate already suppresses the per-run call there, so
    // leaving this undefined for warm deploys keeps the path-owning
    // module's intent explicit. `rm -rf` semantics via `recursive +
    // force` so a run that never wrote scratch (no buildEnv reached) is
    // a no-op rather than an ENOENT throw.
    const cleanupRunStorage: ((runId: string) => Promise<void>) | undefined = env.spawn.warmKeep
      ? undefined
      : (runId: string) =>
          fs.promises.rm(
            runStepStorageRoot({
              dataDir: validated.SIDECAR_DATA_DIR,
              workflowRunRepoId,
              runId,
            }),
            { recursive: true, force: true },
          );

    // Recover a parked correlation's approval snapshot for the child's
    // re-registration enumeration. Wired unconditionally (unlike
    // `cleanupRunStorage`, which is cold-only): a warm agent parks on approval
    // just as a cold one does, and the branch on `warmKeep` selects the durable
    // read -- cold reads the per-attempt isogit store, warm reconstructs the
    // agent's durable conversation state from the substrate.
    const loadParkedApproval: LoadParkedApproval = ({ runId, stepId, attempt, correlationId }) =>
      env.spawn.warmKeep
        ? readWarmParkedApprovalSnapshot({
            substrate,
            workflowRunRepoId,
            stepId,
            correlationId,
          })
        : readColdParkedApprovalSnapshot({
            dataDir: validated.SIDECAR_DATA_DIR,
            workflowRunRepoId,
            runId,
            stepId,
            attempt,
            correlationId,
          });

    // Enumerate a crashed step's durable pending approval operations for the
    // resume classifier, off the same cold/warm durable read as
    // `loadParkedApproval`. Where that binding is a lookup by a known
    // correlationId (answering the supervisor's re-registration), this is the
    // enumeration the classifier needs when the correlationId never reached the
    // log -- the crash-across-park case: read the pending operations, project
    // to the minimal approval records the runtime reconstructs `SignalAwaited`
    // from.
    const readParkedApprovalOps: ReadParkedApprovalOps = async ({ runId, stepId, attempt }) =>
      toParkedApprovalOps(
        env.spawn.warmKeep
          ? await readWarmParkedPendingOperations({
              substrate,
              workflowRunRepoId,
              stepId,
            })
          : await readColdParkedPendingOperations({
              dataDir: validated.SIDECAR_DATA_DIR,
              workflowRunRepoId,
              runId,
              stepId,
              attempt,
            }),
      );

    const bindings: RunWorkflowChildBindings = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      principal,
      invokeStep,
      initialSources: stepInferenceSources,
      runChild,
      runSuspendableChild,
      // A loop iteration runs under the inherited env (not `buildChildRunEnv`),
      // so it is the one body birth path that writes no grants file of its own.
      // Materialize it here -- capping the container run's grants to the loop
      // body's declared resources -- so the body's childWorkflow grandchild
      // spawn is authorized. `definition` is the PRE-rewrite loop body.
      materializeLoopIterationGrants: async ({ parentRunId, childRunId, definition }) => {
        await capAndPersistChildGrants({
          deps: childRunDeps,
          directors: childRunDeps.directors ?? createDefaultDirectorRegistry(),
          definition,
          childRunId,
          parentRunId,
        });
      },
      scheduler,
      evaluateGrants: evaluateGrantsAdapter,
      loadParkedApproval,
      readParkedApprovalOps,
      // The same registry the warm agent's transport registers `watch`
      // callbacks into; `runWorkflowChild` routes each `mailbox.notify` to it.
      mailboxWatchRegistry,
      ...(cleanupRunStorage !== undefined ? { cleanupRunStorage } : {}),
    };
    return bindings;
  };
}

/**
 * Production substrate factory. The sidecar's
 * `bin/workflow-child` binary calls
 * `runWorkflowChildFromProcessEnv(createSubstrate, { substrateConfigKeys: SIDECAR_SUBSTRATE_CONFIG_KEYS })`
 * and the helper invokes this factory with the parsed env. The
 * factory is the default-deps variant of
 * `createSidecarSubstrateFactory`; deployments that need a recording
 * hub sink (tests, alternate hosts) construct their own via
 * `createSidecarSubstrateFactory`.
 */
export const createSubstrate: SubstrateFactory = createSidecarSubstrateFactory();
