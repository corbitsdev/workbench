// Substrate factory the sidecar's `bin/workflow-child` hands to
// `runWorkflowChildFromProcessEnv`. The factory closes over the
// production substrate (`createAgentRepoStore`-backed `RepoStore`),
// the host-process scheduler singleton (adapted to the runtime's
// `Scheduler` shape), and the sidecar's grant-rule evaluator.
//
// The factory consumes the workflow-host's typed `SubstrateFactoryEnv`
// -- the parsed `SpawnTimeEnv` plus a narrow `substrateConfig`
// record carrying only the keys the binary listed in
// `RunWorkflowChildFromProcessEnvOpts.substrateConfigKeys`. The
// factory does not read `process.env` itself; the binary owns the
// only crossing of that boundary.
//
// Single-writer architecture: the workflow-run repo's ref has exactly
// one writer at a time -- the supervisor. The child opens a bare
// `createAgentRepoStore` against the shared on-disk data dir for
// read-only operations (`getRepoDir`, `subscribe`, `resolveRef`,
// etc.) and exposes a proxy `RepoStore` whose
// `writeTreePreservingPrefix` forwards every write over the control
// IPC into the supervisor's substrate. The supervisor's substrate is
// wrapped with the boot-edge pack-push facade, so the hub push fires
// as part of the supervisor's normal write path -- the child does
// not open its own pack-push pipeline.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import { InferenceSource } from "@intx/types/runtime";
import type { InferenceEvent } from "@intx/types/runtime";
import { parseAgentAddress } from "@intx/types";
import { resolveStepAddress } from "@intx/workflow-deploy";
import { sanitizeAddress } from "@workbench/hub-agent";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  createStepAgentFactory,
  runDeterministicToolStep,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
} from "@workbench/agents";
import { createActionToolHandlerRegistry } from "./action-tool-handler";
import { wsUrlToHttp } from "./agent-tools";
import type {
  Agent,
  AgentDefinition,
  BaseEnv,
  DirectorRegistry,
} from "@intx/agent";
import { createAgent, createDefaultDirectorRegistry } from "@intx/agent";
import {
  AdapterManifest,
  createDependencies,
  type AdapterRegistry,
} from "@intx/inference";
// WORKBENCH-LOCAL (CL-2650): the child builds its registry through the shared
// workbench constructor, not upstream's bare `loadAdapterRegistry`.
import { buildWorkbenchAdapterRegistry } from "./gemini-thought-signature-patch";
import { createSSHSignature } from "@intx/crypto";
import {
  createIsogitStore,
  type CommitSigner,
} from "@workbench/storage-isogit";
import {
  createWorkbenchDirectorRegistry,
  createSummarizeCompactor,
  resolveCompactorSource,
  SUMMARIZE_COMPACTOR_NAME,
} from "@workbench/agents";
import {
  createAgentRepoStore,
  type Principal,
  type RepoId,
  type RepoStore,
  type WorkflowRunWorkflowProcessPrincipal,
} from "@workbench/hub-sessions/substrate";
import {
  adaptHostScheduler,
  createProxyWorkflowRunRepoStore,
  createSupervisorBackedTransport,
  createWorkflowHostScheduler,
  createWorkflowRunBlobSubstrate,
  createWorkflowRunRepoStore,
  createWorkflowHostSignalChannel,
  createWorkflowSpawnChild,
  createWorkflowStepInvoker,
  type ChildOutboundMailBridge,
  type GrantEvaluator,
  type RunChildWorkflow,
  type RunWorkflowChildBindings,
  type StepEnvBase,
  type SubstrateFactory,
  type SubstrateFactoryEnv,
  type WarmAgentCache,
} from "@workbench/workflow-host";
import {
  createDurableConversationRegistry,
  type DurableConversationRegistry,
} from "./conversation-state";
import type { MessageTransport } from "@intx/types/runtime";
import {
  baseStepId,
  createNoopDrainController,
  emptyState,
  runtimeRun,
  type Scheduler,
  type StepInvokeRequest,
  type StepInvoker,
  type WorkflowAuthorizeFn,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";

// The child does not construct a workflow-run pack-push pipeline of
// its own. The supervisor owns the workflow-run repo's write
// contract; the supervisor's substrate is wrapped at the sidecar's
// boot edge with the pack-pushing facade so any successful workflow-
// run write fires the hub push automatically. The child's proxy
// `RepoStore` forwards `writeTreePreservingPrefix` over IPC into the
// supervisor's wrapped substrate.

/**
 * Required substrate-config keys the sidecar's binary forwards into
 * the factory's `substrateConfig` slot. Listed here so the binary
 * passes the same names to the helper; the helper enforces
 * presence-and-non-empty against this allowlist before the factory
 * runs.
 *
 * `HUB_WS_URL`, `SIDECAR_ID`, and `SIDECAR_TOKEN` carry the
 * hub-connection trust anchors the child needs to ship workflow-run
 * pack pushes back to the hub. The sidecar's deploy router populates
 * these via the supervisor's `substrateEnv` plumbing
 * (`multistepSubstrateEnv` on `createSidecarDeployRouter`), threaded
 * from the boot edge's own env reads.
 */
export const SIDECAR_SUBSTRATE_CONFIG_KEYS = [
  "SIDECAR_DATA_DIR",
  "WORKFLOW_DEFINITION_REPO_ID",
  "WORKFLOW_DEFINITION_REF",
  "WORKFLOW_RUN_REPO_ID",
  "WORKFLOW_RUN_REF",
  "SIDECAR_SIGNING_PUBLIC_KEY",
  "SIDECAR_SIGNING_PRIVATE_KEY",
  "HUB_WS_URL",
  "SIDECAR_ID",
  "SIDECAR_TOKEN",
  "STEP_INFERENCE_SOURCES",
  // Upstream-added per-step tool-loader caps. The boot edge resolves these via
  // `config.ts` and threads them through `substrateEnv`; the child re-validates
  // them at its boundary. Adopted in the CL-2335 pin bump.
  "SIDECAR_CACHE_MAX_BYTES",
  "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
  "SIDECAR_ADAPTER_MANIFEST",
  // WORKBENCH-LOCAL (CL-2199): the reference sidecar's substrate
  // config carries no TENANT_ID. GTM Workbench threads it so the per-step
  // tool-context resolver can scope hub manifest/credential lookups to the
  // deploying tenant. Pin-bump re-diffs: this key is ours; keep it.
  "TENANT_ID",
  // WORKBENCH-LOCAL (CL-2199): the raw hub deploymentId
  // (`ses_<id>`). The step tool-context resolver derives the step agent
  // row id (`ins_<raw>-<step>`) and agent-state repo id (`<raw>-<step>`)
  // from this, not from the slugified workflow-run repo id in
  // `env.spawn.deploymentId`. The deploy router recovers it from the
  // frame's `agentId` and threads it here. Pin-bump re-diffs: this key is
  // ours; keep it.
  "WORKFLOW_RAW_DEPLOYMENT_ID",
  // WORKBENCH-LOCAL (CL-2199): single-agent (stepCount === 1) tool identity.
  // A single launched agent (Myra/Oat/triage/gate) deploys via interchange's
  // `deployInstanceAtHead`, which writes NO `ins_<raw>-<step>` step agent row
  // and stores its grants in the LEGACY agent-state repo keyed by the
  // instance id (`parseAgentId(address)`), not the synthetic `<raw>-<step>`
  // repo the multi-step deploy writes. So the synthetic `ins_<raw>-default`
  // identity the resolver derives for a multi-step step matches no hub row for
  // a single agent (tool credentials + hub-backed tools 403, grants deny-all).
  // The deploy router threads the REAL agent-definition id (`agt_<defId>`,
  // `frame.agentId`) and the instance principal (`prn_...`,
  // `frame.config.principalId`) here so the resolver's single-agent branch
  // uses the identity the hub actually has. Both keys are always populated (a
  // multi-step deploy sets them to its deployment agent id + supervisor
  // principal, which the resolver's multi-step branch ignores). Pin-bump
  // re-diffs: these keys are ours; keep them.
  "WORKFLOW_SINGLE_AGENT_ID",
  "WORKFLOW_SINGLE_AGENT_PRINCIPAL_ID",
] as const;

const SubstrateConfig = type({
  SIDECAR_DATA_DIR: "string > 0",
  WORKFLOW_DEFINITION_REPO_ID: "string > 0",
  WORKFLOW_DEFINITION_REF: "string > 0",
  WORKFLOW_RUN_REPO_ID: "string > 0",
  WORKFLOW_RUN_REF: "string > 0",
  SIDECAR_SIGNING_PUBLIC_KEY: "string > 0",
  SIDECAR_SIGNING_PRIVATE_KEY: "string > 0",
  HUB_WS_URL: "string > 0",
  SIDECAR_ID: "string > 0",
  SIDECAR_TOKEN: "string > 0",
  STEP_INFERENCE_SOURCES: "string > 0",
  // Per-step tool-loader caps. Validated as non-empty strings here; the
  // numeric positive-finite contract is enforced by `parseByteCap` below.
  SIDECAR_CACHE_MAX_BYTES: "string > 0",
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "string > 0",
  // JSON-encoded custom inference adapter manifest. Required: the boot
  // edge always serializes it into `substrateEnv` (defaulting to "[]"
  // when no custom adapters are configured), so a missing key child-side
  // is a serialization bug and must fail loud here, exactly like the
  // byte-cap fields. Validated as a non-empty string at this boundary;
  // its JSON shape is re-validated against `AdapterManifest` in
  // `parseAdapterManifest` before any module is imported.
  SIDECAR_ADAPTER_MANIFEST: "string > 0",
  // WORKBENCH-LOCAL (CL-2199): not in upstream's SubstrateConfig — the child
  // requires TENANT_ID to scope hub manifest/credential lookups per step.
  TENANT_ID: "string > 0",
  // WORKBENCH-LOCAL (CL-2199): not in upstream's SubstrateConfig — the child
  // requires the raw hub deploymentId to derive step agent/state-repo ids.
  WORKFLOW_RAW_DEPLOYMENT_ID: "string > 0",
  // WORKBENCH-LOCAL (CL-2199): single-agent tool identity (see
  // SIDECAR_SUBSTRATE_CONFIG_KEYS). The real agent-definition id and instance
  // principal the resolver's single-agent branch keys the credential +
  // hub-backed rails on.
  WORKFLOW_SINGLE_AGENT_ID: "string > 0",
  WORKFLOW_SINGLE_AGENT_PRINCIPAL_ID: "string > 0",
}).onUndeclaredKey("ignore");

/**
 * Parse a substrate-config cap entry (`SIDECAR_CACHE_MAX_BYTES` /
 * `SIDECAR_REGISTRY_MAX_TARBALL_BYTES`) into a positive finite number.
 * The boot edge already validated these via the `config.ts` readers
 * before serializing them into `substrateEnv`; this re-parse at the
 * child boundary keeps the typed-config contract honest rather than
 * trusting the wire blindly. Non-finite, zero, or negative inputs are
 * rejected loudly.
 */
export function parseByteCap(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `sidecar workflow-child substrate config: ${name} must be a positive finite number; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Per-step `InferenceSource` table parsed from the spawn-time
 * `STEP_INFERENCE_SOURCES` env entry. The deploy router serializes
 * `frame.workflow.sources` (a `Record<stepId, InferenceSource[]>` — an
 * ordered, non-empty failover chain per step, matching the
 * `AgentDeployFrame` wire contract `InferenceSource.array().atLeastLength(1)`)
 * as JSON and threads it through the supervisor's `substrateEnv`; the
 * factory parses and validates the table once at construction time and
 * pins it for `buildEnv` lookups. The array shape must match upstream's
 * reference sidecar and the router's `JSON.stringify(spec.sources)`; a
 * single-source shape here rejects every real spawn's arrays at the child
 * boundary.
 */
const StepInferenceSourceTable = type({
  "[string]": InferenceSource.array().atLeastLength(1),
});
type StepInferenceSourceTable = typeof StepInferenceSourceTable.infer;

/**
 * Parse and validate the JSON-encoded `STEP_INFERENCE_SOURCES` entry
 * the supervisor threaded through `substrateEnv`. A malformed JSON
 * payload, a non-object root, or a value that does not match
 * `Record<string, InferenceSource[]>` (a non-empty failover chain per
 * step) is rejected at the boundary with a structured error rather than
 * being deferred to a deep-stack `buildEnv` failure.
 */
export function parseStepInferenceSources(
  raw: string,
): StepInferenceSourceTable {
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

/**
 * Parse and validate the JSON-encoded `SIDECAR_ADAPTER_MANIFEST` entry
 * the supervisor threaded through `substrateEnv` from the boot edge's
 * `readAdapterManifest`.
 *
 * Trust boundary: the child's substrate config is operator-supplied
 * (the supervisor's `Bun.spawn` env), so this re-validation is
 * defense-in-depth at the deserialization boundary, NOT a trust
 * upgrade. The manifest was already trusted operator config on the
 * parent side; the same channel already carries the sidecar's signing
 * private key, so it is not a lower-trust surface. Re-asserting the
 * shape here keeps the typed-config contract honest rather than
 * importing modules off an unvalidated wire value.
 *
 * Host contract for custom adapters: a manifest `specifier` must
 * resolve from BOTH the sidecar's and this child's module-resolution
 * roots (the child is a separate `bun` process spawned by the
 * supervisor), and an adapter module MUST be import-side-effect-free —
 * it is imported once per process by `loadAdapterRegistry`, and any
 * top-level side effect would run independently in the parent and in
 * every child.
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

/**
 * Resolve the per-step `InferenceSource` failover chain pinned at
 * factory construction. The supervisor's multi-step branch only invokes
 * a step whose `stepId` appears in `frame.workflow.sources`; a lookup
 * miss here is a programmer error in the supervisor, not a wire-side
 * failure, and the resolver surfaces it with the missing `stepId`
 * named. Returns the ordered, non-empty chain (element 0 is the active
 * source; the rest are failover targets the reactor advances through).
 */
export function createStepInferenceSourceResolver(
  table: StepInferenceSourceTable,
): (stepId: string) => InferenceSource[] {
  return (stepId: string): InferenceSource[] => {
    const direct = table[stepId];
    if (direct !== undefined) return direct;
    // `map` fan-out expands a single `stepOrder` entry `<base>` into per-item
    // stepIds `<base>[<index>]` at run time. Those dynamic ids are not in the
    // statically-pinned `frame.workflow.sources` table (the deploy only knows
    // the static stepOrder), so fall back to the base step's pinned source.
    // Without this, every mapped step — agent OR deterministic — fails the
    // buildEnv lookup. The base step's source is the correct pin: each map
    // iteration runs the SAME inner step definition.
    const mapBase = /^(.+)\[\d+\]$/.exec(stepId);
    const base = mapBase?.[1];
    if (base !== undefined) {
      const baseChain = table[base];
      if (baseChain !== undefined) return baseChain;
    }
    throw new Error(
      `sidecar workflow-child step invoker buildEnv: no InferenceSource pinned for stepId ${JSON.stringify(stepId)}; the supervisor must populate frame.workflow.sources for every stepOrder entry`,
    );
  };
}

function hexDecode(hex: string, name: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(
      `${name} must be even-length hex; got ${String(hex.length)} chars`,
    );
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

/**
 * Dependency overrides accepted by `createSidecarSubstrateFactory`.
 * Production callers omit these to get the default-disk-backed bare
 * store and the IPC-bridge-backed substrate proxy; tests inject an
 * in-memory bare store and/or an explicit substrate-write bridge.
 */
interface SidecarSubstrateFactoryDeps {
  /**
   * Override the bare-store constructor. Production callers omit this
   * to get the `createAgentRepoStore`-backed `RepoStore` against
   * `SIDECAR_DATA_DIR`; tests inject an in-memory recording stub.
   *
   * The bare store backs the child's read-only operations
   * (`getRepoDir`, `subscribe`, `resolveRef`, `listRefs`,
   * `resolveHead`, `createPack`). The child's workflow-run writes do
   * NOT flow through this store; the proxy `RepoStore` forwards them
   * over IPC into the supervisor's substrate.
   */
  createBareRepoStore?: (config: {
    dataDir: string;
    signingKey: { publicKey: Uint8Array; privateKey: Uint8Array };
  }) => RepoStore;

  /**
   * Override the agent factory the real step invoker uses. Production
   * callers omit this to get `@intx/agent`'s `createAgent`; tests inject
   * a stub that returns a deterministic `Agent` without standing up a
   * real inference source, so the invoker's real-reply path is
   * exercisable without a live LLM.
   */
  agentFactory?: <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ) => Promise<Agent>;
}

/**
 * Build a `CommitSigner` from the factory's Ed25519 keypair. Mirrors
 * `apps/sidecar/src/default-harness.ts` (`const signer = (payload) =>
 * crypto.signSSH(payload)` at the `createIsogitStore(storeDir, signer)`
 * call): the live-agent path signs every context/audit commit with the
 * sidecar's SSH-armored Ed25519 signature, and the per-step stores must
 * carry the same provenance.
 */
export function createSidecarCommitSigner(signingKey: {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}): CommitSigner {
  return async (payload: string) =>
    createSSHSignature(payload, signingKey.privateKey, signingKey.publicKey);
}

/**
 * Root directory for a single step invocation's agent-state storage and
 * workspace, derived from the sidecar data dir and the run/step/attempt
 * coordinates the workflow runtime owns. Cold (multi-step) path:
 * `<dataDir>/workflow-step-state/<repoId>/runs/<runId>/steps/<stepId>/attempt-<N>/`.
 *
 * The per-step agent storage is a distinct isogit repo, rooted OUTSIDE
 * the workflow-run repo's working tree (whose single writer is the
 * supervisor, carrying the run-event log under `runs/<runId>/events/...`).
 * Rooting the per-step store under a dedicated `workflow-step-state/`
 * sibling subtree keyed by the workflow-run repo id keeps every step's
 * storage isolated per run and per step while never touching the
 * run-event tree. Adopted from upstream in the CL-2335 pin bump (replaces
 * the prior flat `workflow-steps/<runId>/<stepId>-attempt-<N>/` layout).
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
    sanitizePathSegment(args.workflowRunRepoId.id),
    "runs",
    sanitizePathSegment(args.runId),
    "steps",
    sanitizePathSegment(args.stepId),
    `attempt-${String(args.attempt)}`,
  );
}

/**
 * Root directory for a single workflow-run subtree's per-step scratch:
 * `<dataDir>/workflow-step-state/<repoId>/runs/<runId>/`. The cold path's
 * per-step `stepStorageRoot` nests under this, so reclaiming this subtree
 * on run completion drops every step/attempt the run produced in one
 * `rm -rf`. Kept distinct from `stepStorageRoot` so the deletion
 * granularity (a whole run, not a single step/attempt) is expressed at
 * the call site that owns run-completion cleanup.
 */
export function runStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    sanitizePathSegment(args.workflowRunRepoId.id),
    "runs",
    sanitizePathSegment(args.runId),
  );
}

/**
 * Stable per-agent scratch root for the WARM single-step agent's workspace
 * (upstream design §3b/§4). Keyed by the step identity, NOT by the
 * arbitrary first-message runId: the cached agent reuses ONE workspace
 * across every message in the child's lifetime, and that same workspace is
 * re-derived (and so survives) across a child respawn instead of stranding
 * a fresh per-runId subtree each time. Rooted under a `warm/` sibling of
 * the cold `runs/` subtree so the undeploy sweep of
 * `workflow-step-state/<repoId>/` (see `workflow-host-wiring.ts`) reclaims
 * both with one removal and the two keyings never collide. The durable
 * conversation mirror lives under a different root
 * (`agent-conversation-state/`, see `conversation-state.ts`) that the
 * undeploy sweep deliberately does not touch, so a re-deploy resumes it.
 */
export function warmStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  stepId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    sanitizePathSegment(args.workflowRunRepoId.id),
    "warm",
    sanitizePathSegment(args.stepId),
  );
}

/**
 * Per-step agent-harness env slots the sidecar's substrate factory
 * allocates. Pulled out of `createSidecarSubstrateFactory` so the
 * env-construction is observable in isolation; the closure pins the
 * parsed per-step source table, the per-run data root, the commit
 * signer, and the director registry once, then derives every other
 * `StepEnvBase` slot per step.
 *
 * WORKBENCH-LOCAL (CL-2199): interchange's reference
 * sidecar ships a throwing-Proxy stub for `storage`/`audit`/`workdir`/
 * `directors` and a stub step invoker that never builds a real agent.
 * GTM Workbench wires the real harness here so workflow steps run real
 * inference. Each slot mirrors the live-agent path in `default-harness.ts`
 * (cited per slot) so a workflow step's agent gets the same context
 * store, audit sink, workspace, and director registry a chat agent does.
 * Future pin-bump re-diffs: this block is ours, not upstream's stub.
 */
interface SidecarStepBuildEnvDeps {
  table: StepInferenceSourceTable;
  dataDir: string;
  /**
   * Workflow-run repo identity. Roots the per-step storage subtree under
   * `workflow-step-state/<repoId>/...` (upstream's cold-path layout) so a
   * run-completion sweep of one run never touches another deployment's
   * tree. Optional so the isolated `createSidecarStepInvoker` test seam
   * can omit it; defaults to a stable placeholder repo id.
   */
  workflowRunRepoId?: RepoId;
  signer: CommitSigner;
  directors: DirectorRegistry;
  /**
   * Per-step tool context resolver. Omitted by tests that exercise pure
   * inference; production supplies it so the step env carries the hub
   * connection + grants the tool-capable agentFactory reads back.
   */
  resolveStepToolContext?: (req: StepInvokeRequest) => Promise<StepToolContext>;
  /**
   * Adapter registry the step agent resolves inference adapters through.
   * The child builds this eagerly at boot from the validated
   * `SIDECAR_ADAPTER_MANIFEST` (built-ins merged with operator custom
   * adapters) and the env builder sets it on `env.deps`, so a step whose
   * source names a custom provider resolves in the child exactly as it
   * does on the sidecar main path. Without it the step agent would fall
   * back to `createAgent`'s built-ins-only default and a custom-provider
   * source would fail to resolve at run time.
   */
  adapters: AdapterRegistry;
  /**
   * Durable-conversation registry for the warm single-step agent (upstream
   * §3c). When present (a warm-kept single-step deploy), the env builder
   * roots the per-step scratch STABLY under `warm/<stepId>/` and swaps the
   * per-run isogit `ContextStore` for the per-agent durable store whose
   * conversation is mirrored to the workflow-run substrate, restoring the
   * prior conversation before the env is returned so the agent's reactor
   * `load()` (and the warm cache's lazy build / respawn rebuild) sees the
   * restored turns. Absent for a multi-step deploy, whose per-step agents
   * are not warm/long-lived and need no cross-run conversation durability.
   */
  durableConversation?: DurableConversationRegistry;
  /**
   * Child-side outbound-mail bridge over the control channel (OUTBOUND half
   * of mailbox ownership, §3a). When present alongside `mailboxAddress`, the
   * env builder wraps it in a supervisor-backed `MessageTransport` it
   * supplies as the step agent's `env.transport`; the agent's mail tools
   * call `transport.send`, which routes through the bridge to the supervisor
   * for the actual signed send. The step agent never holds the signing key.
   */
  outboundMailBridge?: ChildOutboundMailBridge;
  /**
   * Deployment mailbox address the supervisor threaded into the child
   * (`MAILBOX_ADDRESS`). Used as the step agent's outbound mail `address`
   * (the identity the host registered its `CryptoProvider` against). Wired
   * together with `outboundMailBridge`.
   */
  mailboxAddress?: string;
}

function createSidecarStepBuildEnv(
  deps: SidecarStepBuildEnvDeps,
): (req: StepInvokeRequest) => Promise<StepEnvBase> {
  const resolveStepInferenceSource = createStepInferenceSourceResolver(
    deps.table,
  );
  const workflowRunRepoId: RepoId = deps.workflowRunRepoId ?? {
    kind: "workflow-run",
    id: "unscoped",
  };
  return async (req: StepInvokeRequest): Promise<StepEnvBase> => {
    const stepId = req.authzContext.stepId;
    if (stepId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.stepId is required for per-step InferenceSource resolution; the workflow runtime must populate stepId on every step-originated invocation",
      );
    }
    const sources = resolveStepInferenceSource(stepId);
    // The table's arktype (`InferenceSource.array().atLeastLength(1)`)
    // guarantees a non-empty chain; assert it here so the reactor's
    // initial-source pin (element 0) is a checked fact rather than an
    // unchecked index.
    const activeSource = sources[0];
    if (activeSource === undefined) {
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: empty InferenceSource chain pinned for stepId ${JSON.stringify(stepId)}`,
      );
    }

    // Per-run/per-step storage root under SIDECAR_DATA_DIR, keyed by
    // repoId + runId + stepId + attempt so concurrent steps never share
    // an isogit lock boundary. The runId comes from the workflow
    // runtime's AuthorizeContext; a step-originated invocation always
    // carries it.
    const runId = req.authzContext.runId;
    if (runId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.runId is required to allocate a per-run step storage root; the workflow runtime must populate runId on every step-originated invocation",
      );
    }
    const attempt = req.authzContext.attempt ?? 1;
    // The cold (multi-step) path keys scratch per run/step/attempt: each run
    // rebuilds the agent and its scratch, and the run's whole `runs/<runId>/`
    // subtree is reclaimed on run completion. The warm single-step path
    // (`durableConversation` present) keys it STABLY per agent under the
    // disjoint `warm/<stepId>/` sub-root so the cached agent reuses one
    // workspace across every message and that workspace survives child
    // respawn; the subtree is reclaimed on undeploy with the rest of
    // `workflow-step-state/<repoId>/`. The two keyings never collide.
    const storeDir =
      deps.durableConversation !== undefined
        ? warmStepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId,
            stepId,
          })
        : stepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId,
            runId,
            stepId,
            attempt,
          });
    await fs.promises.mkdir(storeDir, { recursive: true });

    // `storage`: For the warm single-step agent the conversation must survive
    // child respawn, so it is backed by the per-agent durable store whose
    // content is mirrored to the workflow-run substrate (upstream §3c);
    // `acquire` restores the prior conversation before the agent's reactor
    // loads. A multi-step deploy (no durable registry) keeps the per-run
    // isogit store: its per-step agents are not warm/long-lived and have no
    // cross-run conversation to carry. Mirrors default-harness
    // `const storage = await createIsogitStore(storeDir, signer)`.
    const storage =
      deps.durableConversation !== undefined
        ? (await deps.durableConversation.acquire(stepId)).storage
        : await createIsogitStore(storeDir, deps.signer);

    // Cold-path resume keying assertion (correct-by-construction guard for
    // the resume-attempt invariant documented on `stepStorageRoot`). A
    // resume re-invocation (`req.resume` present) delivers the correlated
    // decision to the reactor, which rehydrates its gate from THIS store's
    // pending operations. The store the runtime reopened is keyed by
    // `attempt` (`stepStorageRoot` above); if that attempt does not match
    // the attempt the step suspended on, the store carries no pending-op
    // for the resumed correlationId, the reactor comes up gateless, and the
    // delivered decision correlates against nothing -- a silent forever-hang.
    // Make that keying violation loud here, at the single seam that both
    // opened the store AND knows a resume must find its gate, rather than
    // letting it surface as a hang. The warm path keys its durable store per
    // agent (not per attempt) and rehydrates from a different lifecycle, so
    // this assertion is cold-path only.
    if (deps.durableConversation === undefined && req.resume !== undefined) {
      const resumeCorrelationId = req.resume.correlationId;
      const loaded = await storage.load();
      const hasPendingOp = loaded.pendingOperations.some(
        (op) => op.correlationId === resumeCorrelationId,
      );
      if (!hasPendingOp) {
        throw new Error(
          `sidecar workflow-child step invoker buildEnv: resume of step ${JSON.stringify(stepId)} (run ${JSON.stringify(runId)}, attempt ${String(attempt)}) reopened a ContextStore with no pending operation for correlationId ${JSON.stringify(resumeCorrelationId)}. The cold-path store is keyed by attempt (${storeDir}); a resume that finds no gate here means it reopened the wrong attempt's store -- the reactor would rehydrate no gate and the delivered decision would correlate against nothing. This is a keying violation, not a recoverable state.`,
        );
      }
    }

    // `audit`: default-harness uses the isogit store as the agent's
    // ContextStore AND a separate mail-audit store (`createMailAuditStore`).
    // The agent harness's BaseEnv.audit is the AuditStore; default-harness
    // passes `audit: storage` in its env literal, so we match that and
    // route the agent's audit records into the same per-step store.
    const audit = storage;

    // `workdir`: per-step workspace dir, mkdir'd recursively. Mirrors
    // default-harness `const workDir = path.join(storeDir, 'workspace');
    // await fs.promises.mkdir(workDir, { recursive: true })`.
    const workdir = path.join(storeDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });

    // Named "summarize" compaction strategy (CL-3803 / CL-3806): runs one
    // bounded inference against the cheap summary model when an
    // openai-compatible source is available, otherwise the agent's own
    // default source (Anthropic-only agents still compact, just on their
    // full-price model). Selection is explicit about provider + model —
    // never first-match of an arbitrary openai-compatible gateway that
    // may not serve SUMMARY_MODEL_ID.
    //
    // Only the warm single-step path (durable conversation) needs long-lived
    // context compaction. Multi-step workflow agents are short-lived and
    // keep the prior behavior of no registered compactor.
    const inferenceDeps = createDependencies(deps.adapters);
    const env: StepEnvBase & Record<string, unknown> = {
      sources,
      defaultSource: activeSource.id,
      storage,
      workdir,
      audit,
      // `directors`: default-harness uses `createWorkbenchDirectorRegistry()`.
      directors: deps.directors,
      // Resolve inference adapters through the child's boot-built
      // registry (built-ins + operator custom adapters), so a
      // custom-provider step source resolves in the child the same way
      // it does on the sidecar main path rather than hitting
      // `createAgent`'s built-ins-only default.
      deps: inferenceDeps,
    };

    if (deps.durableConversation !== undefined) {
      const resolved = resolveCompactorSource(sources);
      if (!resolved.usesCheapSummaryModel) {
        getLogger(["sidecar", "compactor"]).info(
          "summarize compactor falling back to agent default source (provider={provider} model={model}) — no openai-compatible source serving the cheap summary model",
          {
            provider: resolved.source.provider,
            model: resolved.source.model,
            reason: resolved.reason,
            stepId,
          },
        );
      }
      env.compactors = {
        [SUMMARIZE_COMPACTOR_NAME]: createSummarizeCompactor({
          source: resolved.source,
          deps: inferenceDeps,
        }),
      };
    }

    // Supervisor-backed transport for the step agent's mail tools (OUTBOUND
    // half of mailbox ownership, §3a). Inbound is inert -- the supervisor
    // delivers the step input, not through the agent's own mailbox -- and
    // outbound (`send`) routes over the control IPC to the supervisor, which
    // performs the actual signed send as `address`. Without it a
    // mail-sending step agent's `send()` would hang (no transport). Both keys
    // are the env surface `@intx/tools-mail`'s sidecar bundle declares in its
    // `requires`. Wired only when the bridge + address are present (the
    // production path); pure-inference test seams omit them.
    if (
      deps.outboundMailBridge !== undefined &&
      deps.mailboxAddress !== undefined
    ) {
      const transport: MessageTransport = createSupervisorBackedTransport(
        deps.outboundMailBridge,
        deps.mailboxAddress,
      );
      env.transport = transport;
      env.address = deps.mailboxAddress;
    }

    // Stash the per-step tool context so the tool-capable agentFactory can
    // materialize the step's pinned tool packages + credentials + grants.
    // Pure-inference tests omit the resolver; the agentFactory they pair
    // never reads the key.
    if (deps.resolveStepToolContext !== undefined) {
      env[STEP_TOOL_CONTEXT_KEY] = await deps.resolveStepToolContext(req);
    }

    return env;
  };
}

/**
 * Sanitize an id for use as a single on-disk path segment so a stepId
 * or runId carrying a separator cannot escape the per-run subtree.
 */
function sanitizePathSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const logger = getLogger(["sidecar", "workflow-substrate-factory"]);

/** Grants-file path inside a step's agent-state repo working tree. */
const STEP_GRANTS_PATH = "state/grants.json";

const StepGrantsFile = type({ grants: "unknown[]" });

/**
 * Read one step's grants from its agent-state repo working tree, mirroring
 * interchange's supervisor credentials reader
 * (`interchange/packages/workflow-host/src/supervisor/credentials.ts`'s
 * `readStepGrants`): `getRepoDir` is a pure path computation, so the grants
 * file is read straight off disk. A missing file is "no grants" (deny-all,
 * fail-closed); a present-but-malformed file throws so the caller can decide
 * how to handle a corrupt snapshot. `createStepToolContextResolver`
 * deliberately catches that throw and downgrades to deny-all (logging the
 * reason): a corrupt grants file must never silently widen access, and a step
 * with an empty grant set fails closed on every tool call.
 */
async function readStepGrants(args: {
  bareStore: RepoStore;
  repoId: RepoId;
}): Promise<GrantRule[]> {
  const repoId = args.repoId;
  const dir = args.bareStore.getRepoDir(repoId);
  const filePath = path.join(dir, STEP_GRANTS_PATH);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as { code: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `sidecar step grants: ${repoId.kind}/${repoId.id}:${STEP_GRANTS_PATH} is not valid JSON`,
      { cause },
    );
  }
  const validated = StepGrantsFile(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar step grants: ${repoId.kind}/${repoId.id}:${STEP_GRANTS_PATH} failed validation: ${validated.summary}`,
    );
  }
  // The grants file holds the sidecar's GrantRule grammar; the on-disk
  // shape is validated as `unknown[]` and narrowed here at the boundary
  // where the typed grammar is known, matching the parent factory's
  // credentialsSnapshot cast.

  return validated.grants as GrantRule[];
}

const INSTANCE_PREFIX = "ins_";

/**
 * Resolve the on-disk directory holding a step's deploy tree
 * (`<dataDir>/<sanitizeAddress(stepAddress)>`), mirroring interchange's
 * `apps/sidecar/src/step-agent-tools.ts` `stepDeployTreeDir`. The hub stages
 * `deploy/tool-packages-manifest.json` + `deploy/asset-mounts.json` and the
 * asset tarballs (`workspace/`) here at deploy time: single agents at the head
 * via `deployInstanceAtHead`, multi-step steps at their derived address via
 * `stageWorkflowStep`.
 *
 * The step address is recovered from the deployment mailbox address the
 * supervisor threaded into the child (`ins_<deploymentId>@<domain>`): the
 * instance-id local part minus the `ins_` prefix is the deploymentId, the
 * address domain is the deploymentDomain, and `resolveStepAddress` owns the
 * head/step collapse (for `stepCount === 1` the lone step IS the head, read at
 * the deployment mailbox itself; otherwise `deriveStepAddress`). A `map`
 * iteration's scoped id `<base>[<index>]` collapses to its `baseStepId` — every
 * iteration reads the base step's one staged tree.
 */
export function stepDeployTreeDir(args: {
  dataDir: string;
  mailboxAddress: string;
  stepId: string;
  stepCount: number;
}): string {
  const parsed = parseAgentAddress(args.mailboxAddress);
  if (parsed === null || !parsed.instanceId.startsWith(INSTANCE_PREFIX)) {
    throw new Error(
      `sidecar step tool-context: deployment mailbox address ${JSON.stringify(args.mailboxAddress)} is not a parseable ins_<deploymentId>@<domain> agent address; cannot locate the step's on-disk deploy tree`,
    );
  }
  const deploymentId = parsed.instanceId.slice(INSTANCE_PREFIX.length);
  const stepAddress = resolveStepAddress({
    deploymentId,
    stepId: baseStepId(args.stepId),
    deploymentDomain: parsed.domain,
    stepCount: args.stepCount,
  });
  return path.join(args.dataDir, sanitizeAddress(stepAddress));
}

/**
 * Inputs the production step tool-context resolver closes over. The
 * hub-connection anchors come from the validated substrate config.
 */
export interface StepToolContextResolverArgs {
  bareStore: RepoStore;
  /** Sidecar data dir; roots the on-disk deploy-tree lookup. */
  dataDir: string;
  /**
   * Deployment mailbox address (`ins_<deploymentId>@<domain>`) the supervisor
   * threaded into the child. Locates each step's on-disk deploy tree.
   */
  mailboxAddress: string;
  /**
   * Step count for the head/step address collapse. `1` for a single-step
   * (single-agent / warm) deployment — the tree is read at the head; any value
   * `> 1` reads each step at its derived address. Only the `=== 1` branch is
   * significant to `resolveStepAddress`.
   */
  stepCount: number;
  /**
   * RAW hub deploymentId (`ses_<id>`), threaded via
   * `WORKFLOW_RAW_DEPLOYMENT_ID`. NOT the slugified workflow-run repo id
   * in `env.spawn.deploymentId`. The hub keyed the step's `agent` row
   * (`ins_<raw>-<step>`) and agent-state repo (`<raw>-<step>`) on this.
   */
  deploymentId: string;
  tenantId: string;
  hubHttpUrl: string;
  sidecarToken: string;
  /**
   * WORKBENCH-LOCAL (CL-2199): single launched-agent tool identity, applied
   * ONLY when this deploy is a genuine single agent — i.e. `stepCount === 1`
   * AND `singleAgentId !== parseAgentAddress(mailboxAddress).instanceId` (the
   * frame carries a REAL `agt_<defId>` distinct from the deployment instance
   * id). A single launched agent (Myra/Oat/triage/gate) has no `ins_<raw>-<step>`
   * hub row and stores its grants in the LEGACY agent-state repo keyed by the
   * instance id — so the synthetic step identity resolves against nothing.
   * `singleAgentId` is the REAL agent-definition id (`agt_<defId>`) the
   * credential + hub-backed rails authorize against; `singleAgentPrincipalId`
   * is the instance principal (`prn_...`) the hub-backed identity triple
   * resolves the owning instance by.
   *
   * A single-STEP workflow (`stepCount === 1` but `singleAgentId ===
   * instanceId`, because its frame `agentId` is `deriveDeploymentAgentId` ===
   * the supervisor id) and every multi-step step (`stepCount > 1`) ignore both
   * and keep the `ins_<raw>-<step>` identity the hub actually wrote.
   */
  singleAgentId: string;
  singleAgentPrincipalId: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
}

/**
 * Build the per-step tool-context resolver the step env builder calls. It
 * derives the step's persisted `agent` row id (`ins_<deploymentId>-<stepId>`,
 * matching `deriveStepAgentId` / the hub's `writeStepAgentRows`), reads the
 * step's grants from its agent-state repo, and packages the hub-connection
 * anchors the tool-capable agentFactory needs.
 */
export function createStepToolContextResolver(
  args: StepToolContextResolverArgs,
): (req: StepInvokeRequest) => Promise<StepToolContext> {
  return async (req: StepInvokeRequest): Promise<StepToolContext> => {
    const stepId = req.authzContext.stepId;
    if (stepId === undefined) {
      throw new Error(
        "sidecar step tool-context: AuthorizeContext.stepId is required to resolve a step's pinned tool packages",
      );
    }
    // `map` fan-out expands a static stepOrder entry `<base>` into per-item
    // stepIds `<base>[<index>]` at run time. The hub provisions the step agent
    // row, grants, and tool manifest under the STATIC `<base>` id only, so a
    // mapped step must resolve its tool-context against `<base>` — otherwise its
    // declared tools are never loaded ("not in the step's loaded runner").
    const baseStepId = /^(.+)\[\d+\]$/.exec(stepId)?.[1] ?? stepId;

    // WORKBENCH-LOCAL (CL-2199): single launched-agent vs (single- OR multi-)step
    // workflow tool identity.
    //
    // A single launched agent (Myra/Oat/triage/gate) is deployed by interchange's
    // `deployInstanceAtHead`, which writes NO `ins_<raw>-<step>` hub row and stores
    // the agent's grants in the LEGACY agent-state repo keyed by the instance id
    // (`parseAgentId(address)`) — see `createStepStrategy` / `writeStepGrants` in
    // `workflow-host-wiring.ts`. So the synthetic `ins_<raw>-<step>` identity the
    // workflow branch derives matches NOTHING for a single agent: tool credentials
    // 404, hub-backed tools 403, grants read miss (deny-all). Use the identity the
    // hub actually has instead — the REAL agent-definition id (`agt_<defId>`, for
    // the credential/hub-backed agent lookup + toolPackages gate), the instance
    // principal (`prn_...`, so the hub-backed identity triple resolves the owning
    // instance), and the legacy grants repo.
    //
    // The discriminator is DEPLOY PROVENANCE, not `stepCount`. `stepCount === 1`
    // is ALSO true for a single-STEP workflow definition (`stepOrder.length === 1`),
    // which is NOT a launched agent: it is deployed via `deploySingleStepAtHead`,
    // whose frame carries `deriveDeploymentAgentId(deploymentId)` (=== the mailbox
    // address's instance id `ins_<deploymentId>`) as `agentId` and the EMPTY
    // supervisor `agent` row (`writeDeploymentAgentRow`: `toolPackages: []`,
    // `capabilities: null`). Keying tool/credential/grant resolution on that
    // supervisor identity strands the single-step workflow's REAL step tools +
    // grants, which the hub wrote at `ins_<deploymentId>-<stepId>` /
    // `<deploymentId>-<stepId>` (`writeStepAgentRows` / `writeStepGrantFiles`) — the
    // exact `ins_<raw>-<step>` identity the else branch derives. A single launched
    // agent instead carries a REAL `agt_<defId>` frame `agentId`, distinct from the
    // instance id — so `singleAgentId !== instanceId` is the signal that this is a
    // genuine single agent and the single-agent branch applies. The on-disk deploy
    // tree location is a SEPARATE decision (`stepDeployTreeDir`, keyed off the
    // physical `stepCount === 1` head collapse) and is unchanged: both a single
    // agent and a single-step workflow stage their tree at the head.
    //
    // A genuine multi-step step keeps the `ins_<raw>-<step>` identity for the same
    // reason a single-step workflow does — the hub's `writeStepAgentRows` /
    // `writeStepGrantFiles` persist the matching `agent` row and `<raw>-<step>`
    // grants repo for it.
    const mailboxParsed = parseAgentAddress(args.mailboxAddress);
    if (mailboxParsed === null) {
      throw new Error(
        `sidecar step tool-context: deployment mailbox address ${JSON.stringify(args.mailboxAddress)} is not a parseable agent address; cannot resolve the step's tool identity`,
      );
    }
    const isSingleLaunchedAgent =
      args.stepCount === 1 && args.singleAgentId !== mailboxParsed.instanceId;

    let stepAgentId: string;
    let principalId: string;
    let stepAddress: string;
    let grantsRepoId: RepoId;
    let includeRunId: boolean;
    if (isSingleLaunchedAgent) {
      stepAgentId = args.singleAgentId;
      principalId = args.singleAgentPrincipalId;
      stepAddress = args.mailboxAddress;
      grantsRepoId = { kind: "agent-state", id: mailboxParsed.instanceId };
      // A warm single-step agent's per-message runId is NOT a workflow-run
      // record id; forwarding it would trigger a spurious run lookup on the
      // hub. The single agent resolves tenant tool credentials, so omit it.
      includeRunId = false;
    } else {
      // Must stay identical to `@intx/workflow-deploy`'s exported
      // `deriveStepAgentId` (`ins_<deploymentId>-<stepId>`), which the hub's
      // `writeStepAgentRows` uses to persist the row this id resolves.
      // `args.deploymentId` is the RAW hub deploymentId (`ses_<id>`), so this
      // yields `ins_ses_<id>-<step>` — the row the hub registered. The template
      // is hand-rolled here (not imported) because `@intx/workflow-deploy` is
      // not a sidecar dependency; on any change to that helper, update this.
      stepAgentId = `ins_${args.deploymentId}-${baseStepId}`;
      principalId = stepAgentId;
      stepAddress = stepAgentId;
      grantsRepoId = {
        kind: "agent-state",
        id: `${args.deploymentId}-${baseStepId}`,
      };
      includeRunId = true;
    }

    let grants: GrantRule[];
    try {
      grants = await readStepGrants({
        bareStore: args.bareStore,
        repoId: grantsRepoId,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn`step tool-context: failed to read grants for ${stepAgentId}, falling back to deny-all: ${reason}`;
      grants = [];
    }
    const runId = req.authzContext.runId;
    const deployTreeDir = stepDeployTreeDir({
      dataDir: args.dataDir,
      mailboxAddress: args.mailboxAddress,
      stepId,
      stepCount: args.stepCount,
    });
    return {
      hubHttpUrl: args.hubHttpUrl,
      sidecarToken: args.sidecarToken,
      tenantId: args.tenantId,
      stepAgentId,
      stepAddress,
      principalId,
      ...(includeRunId && runId !== undefined ? { workflowRunId: runId } : {}),
      grants,
      deployTreeDir,
      cacheRoot: args.cacheRoot,
      cacheMaxBytes: args.cacheMaxBytes,
      registryMaxTarballBytes: args.registryMaxTarballBytes,
    };
  };
}

/**
 * Adapt the factory's `GrantEvaluator` (the sidecar's grant-rule
 * evaluator, which takes a per-step `grants` array) into the
 * `WorkflowAuthorizeFn` the production step-invoker adapter requires.
 *
 * The step-invoker seam does not thread a per-step credentialsSnapshot
 * (that machinery is the supervisor's `createCredentialsBackedAuthorize`
 * path inside `@intx/workflow-host`'s run-child, which builds the
 * runtime env's own `authorize` from `bindings.evaluateGrants` — a slot
 * the step invoker does not receive). For a pure-inference step the
 * agent never calls `authorize`, so this closure is only exercised when
 * a step agent invokes a tool. It evaluates against an empty grant set,
 * which fails closed (deny) for any tool authz — the correct, loud
 * default until per-step grants are threaded into this seam. Real
 * tool-credential resolution for tool-using step agents is NOT wired
 * here; inference is.
 */
function createSidecarStepWorkflowAuthorize(
  evaluate: GrantEvaluator,
): WorkflowAuthorizeFn {
  return async (resource, action, ctx) =>
    evaluate({
      resource,
      action,
      stepId: ctx?.stepId ?? "",
      attempt: ctx?.attempt,
      runId: ctx?.runId,
      grants: [],
    });
}

/**
 * The interchange default director (see `packages/inference/src/
 * default-director.ts`, vendored) degrades `inference.error` to a
 * `checkpoint + reply` action carrying the formatted error text as the
 * reply — correct for a conversational agent (the human sees the error and
 * can retry), wrong for an unattended workflow step: `agent.send` resolves
 * `{ type: "reply" }` exactly as it would for a genuine successful turn, so
 * `stepResultFromSend` (`@workbench/workflow-host`) hands the step's output
 * `{ reply: "<formatted provider error>", turn }` and the step COMPLETES.
 * A downstream step then tries to parse structured data out of that error
 * string and fails with a confusing, unrelated error many steps later — the
 * root failure (an inference-provider error) never surfaces as a step
 * failure at all.
 *
 * There is no seam on `SendResult`/`StepInvokeResult` distinguishing "this
 * reply is the formatted text of an `inference.error`" from a genuine
 * assistant reply — the director's `reply` action is a plain string. This
 * tracker observes the per-step `InferenceEvent` stream (already threaded
 * through `onEvent` for observability) and records whether an
 * `inference.error` fired during the CURRENT step invocation. Because the
 * default director's `inference.error` branch is a terminal action for
 * its message-run (closes the bracket, returns to waiting — see
 * `default-director.ts`), an `inference.error` and a genuine successful
 * reply can never both settle the same `agent.send()` call: observing one
 * during a call that resolved with a reply means that reply IS the
 * error text.
 *
 * `reset()` must be called at the start of every step invocation (both the
 * deterministic and inference branches use the same tracker instance) so a
 * PRIOR step's error does not leak onto the next step's success.
 *
 * Concurrency safety is load-bearing and comes from the CALLER: `buildStepInvoker`
 * constructs a fresh `createSidecarStepInvoker` — and therefore a fresh tracker
 * closure — for every `invokeStep` request, so concurrently running steps never
 * share one. Pooling or reusing invokers for performance would silently break
 * that and let one step's inference error settle another step's result.
 */
function createStepInvokerErrorTracker(
  forward: ((event: InferenceEvent) => void) | undefined,
): {
  onEvent: (event: InferenceEvent) => void;
  reset: () => void;
  lastError: () => { message: string; category: string } | undefined;
} {
  let last: { message: string; category: string } | undefined;
  return {
    onEvent: (event) => {
      if (event.type === "inference.error") {
        last = {
          message: event.data.error.message,
          category: event.data.error.category,
        };
      }
      forward?.(event);
    },
    reset: () => {
      last = undefined;
    },
    lastError: () => last,
  };
}

/**
 * Thrown when a reasoning workflow step's `agent.send` resolved with a reply
 * that is the formatted text of an `inference.error` the default director
 * degraded to a reply (see `createStepInvokerErrorTracker`). Named so the
 * run-failure detail names the real cause (a provider/inference failure)
 * instead of surfacing as the misleading "reply" content some downstream
 * step failed to parse.
 */
export class StepInferenceFailedError extends Error {
  readonly category: string;
  constructor(message: string, category: string) {
    super(
      `workflow step's inference call failed (category: ${category}): ${message}`,
    );
    this.name = "StepInferenceFailedError";
    this.category = category;
  }
}

/**
 * Compose the real `createWorkflowStepInvoker` adapter for the
 * sidecar's parent-step path. Exported so the wiring is testable in
 * isolation: a test injects a stub `agentFactory` and asserts the step
 * output carries the agent's real reply rather than the upstream stub
 * shape. Production wires the same composition inside
 * `createSidecarSubstrateFactory`.
 */
export function createSidecarStepInvoker(args: {
  table: StepInferenceSourceTable;
  dataDir: string;
  /** Workflow-run repo identity; roots the per-step storage subtree. */
  workflowRunRepoId?: RepoId;
  signer: CommitSigner;
  directors: DirectorRegistry;
  /** Adapter registry the step agent resolves inference adapters through. */
  adapters: AdapterRegistry;
  evaluateGrants: GrantEvaluator;
  /**
   * Per-step tool-context resolver. Production supplies it so each step
   * agent is built tool-capable (its pinned packages + credentials +
   * grants); tests exercising pure inference omit it and the env builder
   * stashes nothing.
   */
  resolveStepToolContext?: (req: StepInvokeRequest) => Promise<StepToolContext>;
  agentFactory?: <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ) => Promise<Agent>;
  /**
   * Per-step workflow-typed authorize. Upstream's `ChildStepInvoker` now
   * hands the runtime's credentials-backed authorize closure per
   * invocation; the factory's `invokeStep` binding threads it here so the
   * real inference path gates each tool call against the step's grant
   * snapshot. Absent (the isolated test seam) it falls back to the
   * grant-evaluator-derived deny-on-empty authorize.
   */
  workflowAuthorize?: WorkflowAuthorizeFn;
  /** Per-step inference event sink (upstream `onEvent`). */
  onEvent?: (event: InferenceEvent) => void;
  /**
   * Warm single-step agent cache (upstream §3b), supplied by the run-loop
   * for a warm-kept single-step deployment. When present the inference
   * invoker builds the agent once and reuses it across messages instead of
   * instantiate-send-teardown per message. Absent for the cold path.
   */
  warmCache?: WarmAgentCache;
  /**
   * Run-boundary durability flush (upstream §3c). Invoked with the warm
   * cache key (the stepId) after each message's `send` settles so the warm
   * agent's conversation snapshot is mirrored to the substrate before the
   * next message. Wired only alongside `warmCache`.
   */
  onRunBoundary?: (key: string) => Promise<void>;
  /**
   * Durable-conversation registry for the warm path. Threaded into the env
   * builder so the warm agent's `storage` is the durable per-agent store.
   */
  durableConversation?: DurableConversationRegistry;
  /** Outbound-mail bridge for the step agent's supervisor-backed transport. */
  outboundMailBridge?: ChildOutboundMailBridge;
  /** Deployment mailbox address; the step agent's outbound `address`. */
  mailboxAddress?: string;
  /**
   * WORKBENCH-LOCAL: true for a WARM single-step deployment (the sole warm
   * agent — Myra/Oat/triage/gate), false for a genuine multi-step workflow
   * step. Threaded into the tool-capable `createStepAgentFactory` so a warm
   * agent resolves its director from its prompt markers and wires the dynamic
   * tool catalog + exposure (the retired `default-harness` semantics), while a
   * multi-step step keeps the budget director unconditionally. Sourced from
   * `env.spawn.warmKeep`.
   */
  warmKeep?: boolean;
}): StepInvoker {
  const buildEnv = createSidecarStepBuildEnv({
    table: args.table,
    dataDir: args.dataDir,
    signer: args.signer,
    directors: args.directors,
    adapters: args.adapters,
    ...(args.workflowRunRepoId !== undefined
      ? { workflowRunRepoId: args.workflowRunRepoId }
      : {}),
    ...(args.resolveStepToolContext !== undefined
      ? { resolveStepToolContext: args.resolveStepToolContext }
      : {}),
    ...(args.durableConversation !== undefined
      ? { durableConversation: args.durableConversation }
      : {}),
    ...(args.outboundMailBridge !== undefined
      ? { outboundMailBridge: args.outboundMailBridge }
      : {}),
    ...(args.mailboxAddress !== undefined
      ? { mailboxAddress: args.mailboxAddress }
      : {}),
  });

  // WORKBENCH-LOCAL: track the most recent `inference.error` event seen
  // during the CURRENT `inferenceInvoker` call, so the returned invoker
  // below can tell a step's terminal reply apart from a provider error the
  // director degraded to a reply (see `stepInvokerErrorTracker` docstring).
  const errorTracker = createStepInvokerErrorTracker(args.onEvent);

  const inferenceInvoker = createWorkflowStepInvoker({
    workflowAuthorize:
      args.workflowAuthorize ??
      createSidecarStepWorkflowAuthorize(args.evaluateGrants),
    buildEnv,
    // The step's `req.agent.toolFactories` are walk-only stubs; the
    // tool-capable factory ignores them and builds the real runner from the
    // step's pins. A test-injected `agentFactory` (pure inference) is wired
    // verbatim instead.
    agentFactory:
      args.agentFactory ??
      (args.resolveStepToolContext !== undefined
        ? createStepAgentFactory({
            ...(args.warmKeep !== undefined ? { warmKeep: args.warmKeep } : {}),
          })
        : createAgent),
    onEvent: errorTracker.onEvent,
    // Warm-keep wiring (upstream §3b/§3c): forward the run-loop's per-
    // deployment warm cache and the run-boundary durability flush so the
    // inference invoker reuses one cached agent across messages and mirrors
    // its conversation to the substrate after each send. Absent for the cold
    // path (every step is instantiate-send-teardown).
    ...(args.warmCache !== undefined ? { warmCache: args.warmCache } : {}),
    ...(args.onRunBoundary !== undefined
      ? { onRunBoundary: args.onRunBoundary }
      : {}),
  });

  // Deterministic-tool dispatch (CL-2202). A step whose placeholder agent
  // carries the deterministic marker tags is a pure tool/API call: build the
  // step env (which materializes the per-step tool context) and invoke the
  // named tool directly, skipping the reactor + inference entirely. Every
  // other step (every reasoning step, native or historical) delegates to the
  // real inference invoker above. The existing test seam (a test-injected
  // `agentFactory` for pure inference) is untouched — the deterministic
  // branch only triggers on the tag.
  //
  // The former inline single-turn inference dispatch (CL-2251) is retired:
  // staging-only step provisioning removed the per-step session cost it
  // existed to dodge, so every reasoning step — including what used to be
  // authored as `inlineInferenceStep` — now runs through the same real
  // `inferenceInvoker`/`createStepAgentFactory` path as any other deployed
  // step.
  return async (req) => {
    const tags = req.agent.tags;
    const toolName = tags?.[STEP_TOOL_TAG];
    if (
      tags?.[STEP_KIND_TAG] === DETERMINISTIC_TOOL_KIND &&
      toolName !== undefined
    ) {
      const env = await buildEnv(req);
      const argMapJson = tags?.[STEP_ARGMAP_TAG];
      // WORKBENCH-LOCAL (CL-2401): a step tagged non-fatal degrades a thrown
      // tool error to a completed isError envelope so one dead best-effort
      // source can't flip the whole run to RunFailed.
      const nonFatal = tags?.[STEP_NONFATAL_TAG] === "true";
      return runDeterministicToolStep({
        env,
        toolName,
        input: req.input,
        ...(argMapJson !== undefined ? { argMapJson } : {}),
        ...(nonFatal ? { nonFatal } : {}),
        signal: req.signal,
      });
    }
    // WORKBENCH-LOCAL: reset the per-invocation error tracker before every
    // reasoning-step call, then fail the step loudly if this call's result
    // is the director's degraded inference-error reply rather than a
    // genuine assistant reply. Scoped to genuine multi-step workflow steps
    // (`warmKeep !== true`): a WARM single-step agent (Myra/Oat/triage/gate)
    // is a conversational deployment where the default director's
    // reply-on-error behavior is intentional — the human sees the error in
    // chat and can retry — so it keeps that behavior unchanged. See
    // `createStepInvokerErrorTracker` and `StepInferenceFailedError` above.
    errorTracker.reset();
    const result = await inferenceInvoker(req);
    if (args.warmKeep !== true && "output" in result) {
      const lastError = errorTracker.lastError();
      if (lastError !== undefined) {
        throw new StepInferenceFailedError(
          lastError.message,
          lastError.category,
        );
      }
    }
    return result;
  };
}

/**
 * Inputs required to construct the sidecar's in-process child runtime.
 * Lifted out of `createSidecarSubstrateFactory` so the implementation
 * is exercisable in isolation (the co-located test wires a hand-built
 * substrate/principal/scheduler/invokeStep against this surface).
 *
 * Sub-namespace scoping: the child runtime is invoked with
 * `runId: childRunId`. The runtime body threads that id through every
 * `repoStore.read/append/subscribe` call, every `blobs.recordOutput`
 * call, and every `signalChannel.deliver/awaitNext` call. The host-
 * adapter implementations (`createWorkflowRunRepoStore`,
 * `createWorkflowRunBlobSubstrate`, `createWorkflowHostSignalChannel`)
 * each compute their on-disk path as `runs/<runId>/...` against the
 * supplied workflow-run repo. The net effect is that the child's
 * events land under `runs/<childRunId>/events/<seq>.json` of the
 * parent's workflow-run repo, sibling to the parent's own
 * `runs/<parentRunId>/...` subtree.
 *
 * Substrate identity: the child reuses the parent's wrapped `RepoStore`
 * (the workflow-run pack-pushing wrap installed by the factory) so a
 * successful child write fires the same hub pack push the parent's
 * writes do. The substrate's signing principal (a workflow-process
 * principal scoped to the parent's deploymentId) is reused verbatim
 * because the child runs under the same supervisor authority.
 */
interface SidecarRunChildDeps {
  /** Wrapped workflow-run substrate (the factory's `substrate`). */
  substrate: RepoStore;
  /** Workflow-run repo identifying the parent's deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run ref the child reads/writes against. */
  workflowRunRef: string;
  /**
   * Deploy ref the child env's recursive `spawnChild` resolves
   * grandchild `definitionRef`s against. The runtime body's
   * `runChildWorkflow` was designed for arbitrary depth; the child's
   * env's `spawnChild` slot must itself be a `createWorkflowSpawnChild`
   * adapter against this deploy ref so a grandchild spawn resolves
   * the grandchild's `workflow.json` from the workflow asset substrate
   * the same way the parent's spawn does. The sub-namespace scoping
   * (`runs/<runId>/...`) continues to work because each rung's
   * runtime env routes through `runId`-keyed substrate adapters.
   */
  workflowDefinitionRef: string;
  /** Principal the child presents on every substrate operation. */
  principal: Principal;
  /** Host-process scheduler singleton; shared with the parent. */
  scheduler: Scheduler;
  /**
   * Step invoker the child runtime delegates per-step invocations to.
   *
   * The in-process child runs a WorkflowDefinition whose stepIds are
   * disjoint from the parent's. The parent's
   * `STEP_INFERENCE_SOURCES`-pinned `buildStepEnv` knows only the
   * parent's stepIds and throws on any other id; routing the child's
   * step invocations through that closure surfaces a misleading
   * "no InferenceSource pinned" error for every child step. Callers
   * therefore supply a SEPARATE invokeStep for the child that does
   * not consult the parent's pinned source table. The substrate
   * factory's default wires a stub that mirrors the parent's stub
   * step output (`{ output: { reply: req.agent.id, turn: null } }`)
   * without resolving any per-step InferenceSource -- threading the
   * child's WorkflowDefinition-derived sources into a real inference
   * call is on the same agent-harness wiring backlog as the parent's
   * stub.
   */
  invokeStep: StepInvoker;
  /** Director registry the child runtime uses; defaults to the canonical built-ins. */
  directors?: DirectorRegistry;
  /** Clock for timestamp generation; defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Random id generator for run ids, signal ids, timer ids; defaults to
   * a monotonic counter combined with a random suffix.
   */
  newId?: (prefix: string) => string;
}

/**
 * Construct the `RunChildWorkflow` callback the spawn-child adapter
 * delegates to. The returned callback, when invoked with the parent
 * runtime's attribution + the parent-allocated `childRunId` + the
 * resolved `WorkflowDefinition`, builds a fresh `WorkflowRuntimeEnv`
 * scoped to `childRunId`, invokes `runtimeRun`, and returns the
 * child's terminal status.
 *
 * Abort propagation: the parent-supplied `signal` is observed at every
 * runtime observation point. If the signal aborts mid-flight the
 * runtime body's cancel cascade fires and the returned promise
 * resolves with `terminalStatus: "cancelled"`. A pre-aborted signal is
 * handled by the spawn-child adapter's entry-time short-circuit; the
 * runChild callback itself does not see the pre-abort case.
 *
 * Resource lifecycle: the child's per-run signal channel handle is
 * `stop()`ped in a finally block so any background `subscribeKind`
 * loop tied to the child's runId tears down before the callback
 * returns. The blob substrate, repo store, and scheduler entries are
 * either per-call (no handle to dispose) or shared with the parent
 * (the scheduler).
 */
export function createSidecarRunChild(
  deps: SidecarRunChildDeps,
): RunChildWorkflow {
  const directors = deps.directors ?? createDefaultDirectorRegistry();
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? defaultNewId;
  const repoStore = createWorkflowRunRepoStore({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    ref: deps.workflowRunRef,
  });
  // Self-referential `RunChildWorkflow` so a child env's recursive
  // `spawnChild` (built via `createWorkflowSpawnChild` below) can route
  // grandchild spawns back through the same adapter. Each invocation
  // builds a per-runId env that itself wires a `spawnChild` slot whose
  // `runChild` is this same `runChild` constant -- the recursion bottoms
  // out when a rung's `WorkflowDefinition` has no `childWorkflow`
  // primitive. Sub-namespace scoping continues to hold at every depth
  // because `childRunId` flows verbatim into the per-rung
  // `blobs`/`signalChannel`/`runtimeRun` calls, keeping every rung's
  // events under `runs/<runId>/...` of the parent's workflow-run repo.
  const runChild: RunChildWorkflow = async ({
    definition,
    childRunId,
    input,
    signal,
  }) => {
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
    // The child's `env.authorize` slot is the workflow-typed authorize
    // the runtime body stores; the runtime body never reads it
    // directly. Step invocations route through `invokeStep`, which
    // wires its own `BaseEnv.authorize` against the workflow-typed
    // callback. Throwing here surfaces a precise "no credentialsRef
    // installed" error if a future wiring forgets to inject one.
    const authorize: WorkflowAuthorizeFn = () => {
      // The slot is intentionally throwing: a step that actually calls
      // `env.authorize` is asking for a per-step credentials snapshot
      // that the sub-namespace child does not yet inherit from the
      // parent's `runWorkflowChild` credentialsRef. The slot is
      // observable to tests that wire an `invokeStep` bypassing
      // authorize.
      throw new Error(
        "sidecar runChild authorize: per-step credentials snapshot is not threaded through the spawn-child seam; the child runtime cannot resolve a workflow-typed authorize call",
      );
    };
    const drain = createNoopDrainController(definition);
    // Recursive `spawnChild`: a grandchild's `definitionRef` is resolved
    // against the workflow-asset substrate the parent's spawn used, and
    // the resolved `WorkflowDefinition` flows back into this same
    // `runChild` callback. The runtime body's `runChildWorkflow`
    // contract is depth-agnostic; the wiring here makes the sidecar's
    // adapter depth-agnostic too.
    const spawnChild = createWorkflowSpawnChild({
      substrate: deps.substrate,
      principal: deps.principal,
      deployRef: deps.workflowDefinitionRef,
      runChild,
    });
    const env: WorkflowRuntimeEnv = {
      repoStore,
      scheduler: deps.scheduler,
      signalChannel,
      blobs,
      directors,
      authorize,
      invokeStep: deps.invokeStep,
      spawnChild,
      clock,
      newId,
      drain,
    };
    try {
      const handle = runtimeRun(definition, env, {
        runId: childRunId,
        triggerPayload: input,
      });
      const cancelOnAbort = (): void => {
        void handle.cancel("supervisor-operator", "parent cancelled");
      };
      if (signal.aborted) {
        cancelOnAbort();
      } else {
        signal.addEventListener("abort", cancelOnAbort, { once: true });
      }
      try {
        const result = await handle.complete;
        return { terminalStatus: result.terminalStatus };
      } finally {
        signal.removeEventListener("abort", cancelOnAbort);
      }
    } finally {
      await signalChannel.stop();
    }
  };
  return runChild;
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
 * Build a `SubstrateFactory` closed over the supplied dependency
 * overrides. The production export `createSubstrate` is the
 * default-deps call.
 *
 * Construction order:
 *   1. Narrow the `substrateConfig` record against the typed schema.
 *      A missing or empty key already threw inside the helper; this
 *      pass enforces the exact shape the factory consumes.
 *   2. Open a bare `RepoStore` via `createAgentRepoStore` against the
 *      sidecar's data dir and Ed25519 keypair. This store backs the
 *      child's read-only operations against the workflow-run repo;
 *      the on-disk repo is shared with the supervisor's substrate so
 *      reads see whatever the supervisor has committed.
 *   3. Construct a proxy `RepoStore` whose
 *      `writeTreePreservingPrefix` forwards over the upstream control
 *      channel via the substrate-write bridge. The supervisor's
 *      handler runs its own substrate's `writeTreePreservingPrefix`
 *      (wrapped at the boot edge with the pack-push facade) under the
 *      per-repo lock and replies with the resulting `commitSha`.
 *   4. Start the host-process scheduler singleton against the proxy
 *      substrate, then adapt it to the runtime's `Scheduler` shape.
 *   5. Construct the production `invokeStep` and `spawnChild`
 *      adapters.
 *   6. Return the `RunWorkflowChildBindings` the runtime body
 *      consumes, with the proxy store in the `substrate` slot.
 */
export function createSidecarSubstrateFactory(
  deps: SidecarSubstrateFactoryDeps = {},
): SubstrateFactory {
  const createBareRepoStore =
    deps.createBareRepoStore ??
    (({ dataDir, signingKey }) =>
      createAgentRepoStore({ dataDir, signingKey }).repoStore);

  return async (env: SubstrateFactoryEnv) => {
    const validated = SubstrateConfig(env.substrateConfig);
    if (validated instanceof type.errors) {
      throw new Error(
        `sidecar workflow-child substrate config failed validation: ${validated.summary}`,
      );
    }

    const stepInferenceSources = parseStepInferenceSources(
      validated.STEP_INFERENCE_SOURCES,
    );

    // Build the child's adapter registry eagerly at boot from the
    // operator-supplied manifest. `loadAdapterRegistry` imports every
    // custom module now, so a bad specifier crashes the child loudly at
    // construction rather than silently degrading to built-ins-only at
    // first resolve. The closure registry the sidecar built at its own
    // boot edge cannot cross the fork; the child rebuilds an equivalent
    // one from the serialized-and-revalidated manifest.
    // WORKBENCH-LOCAL (CL-2650): build through buildWorkbenchAdapterRegistry
    // so the child gets the same BD-394 gemini thought-signature wrap as the
    // main sidecar path — a bare loadAdapterRegistry here would silently drop
    // the workaround for google-genai steps run in the child.
    const childAdapterRegistry = await buildWorkbenchAdapterRegistry(
      parseAdapterManifest(validated.SIDECAR_ADAPTER_MANIFEST),
    );

    // Per-step tool-loader caps the boot edge resolved and threaded through
    // `substrateEnv`; re-validated at the child boundary (upstream CL-2335).
    const cacheMaxBytes = parseByteCap(
      validated.SIDECAR_CACHE_MAX_BYTES,
      "SIDECAR_CACHE_MAX_BYTES",
    );
    const registryMaxTarballBytes = parseByteCap(
      validated.SIDECAR_REGISTRY_MAX_TARBALL_BYTES,
      "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
    );

    const signingKey = {
      publicKey: hexDecode(
        validated.SIDECAR_SIGNING_PUBLIC_KEY,
        "SIDECAR_SIGNING_PUBLIC_KEY",
      ),
      privateKey: hexDecode(
        validated.SIDECAR_SIGNING_PRIVATE_KEY,
        "SIDECAR_SIGNING_PRIVATE_KEY",
      ),
    };

    const bareStore: RepoStore = createBareRepoStore({
      dataDir: validated.SIDECAR_DATA_DIR,
      signingKey,
    });

    const workflowRunRepoId = {
      kind: "workflow-run" as const,
      id: validated.WORKFLOW_RUN_REPO_ID,
    };
    const workflowDefinitionRepoId = {
      kind: "workflow" as const,
      id: validated.WORKFLOW_DEFINITION_REPO_ID,
    };
    const principal: WorkflowRunWorkflowProcessPrincipal = {
      kind: "workflow-process",
      deploymentId: env.spawn.deploymentId,
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

    const hostScheduler = createWorkflowHostScheduler({
      repoStore: substrate,
      principal,
      listActiveDeployments: () => [workflowRunRepoId],
      ref: validated.WORKFLOW_RUN_REF,
      clock: () => new Date(),
    });
    await hostScheduler.start();
    const scheduler = adaptHostScheduler(hostScheduler);

    const evaluateGrantsAdapter: GrantEvaluator = async ({
      resource,
      action,
      grants,
    }) => {
      const result = await evaluateGrants(
        // The credentialsSnapshot's grants are typed as
        // `readonly unknown[]` so the workflow-host package does not
        // depend on the sidecar's grant-rule grammar. The sidecar owns
        // that grammar; the cast surfaces here at the boundary where
        // the typed grant shape is known.

        [...(grants as readonly GrantRule[])],
        resource,
        action,
      );
      return {
        effect: result.effect,
        matchingGrants: [],
        resolvedBy: null,
      };
    };

    // WORKBENCH-LOCAL (CL-2199): not in upstream reference sidecar.
    // Interchange's reference `apps/sidecar` ships a stub step invoker
    // here (`return { output: { reply: req.agent.id, turn: null } }`)
    // that never builds an agent, so workflows produce canned output.
    // GTM Workbench wires the real `createWorkflowStepInvoker` adapter
    // from `@intx/workflow-host` so each step instantiates a real agent
    // (`createAgent(req.agent, env)`) and runs real inference via
    // `agent.send(input)`. The per-step `BaseEnv` slots are built by
    // `createSidecarStepBuildEnv`, mirroring `default-harness.ts`
    // (storage/audit/workdir/directors); the workflow-typed authorize
    // is adapted from the factory's grant evaluator. Future pin-bump
    // re-diffs: this invoker is ours, not upstream's stub.
    // Per-step tool context: derive the step's persisted `agent` row id,
    // read its grants from the agent-state repo, and package the hub
    // connection anchors so the tool-capable step agentFactory can
    // materialize the step's pinned tool packages + tenant credentials.
    // The cache root mirrors the live harness default
    // (`<dataDir>/cache/tool-packages`); the byte limits use the same
    // defaults the live config applies when the env override is absent.
    const resolveStepToolContext = createStepToolContextResolver({
      bareStore,
      // RAW hub deploymentId (`ses_<id>`), NOT `env.spawn.deploymentId`
      // (the slugified workflow-run repo id). The step agent row id and
      // agent-state repo id the hub persisted are keyed on the raw id; the
      // slug would make the step's credential lookup 404 and its grants read
      // miss (deny-all). See `RAW_DEPLOYMENT_ID_ENV_KEY`. This id keys the
      // KEPT credential + hub-backed rails; it does NOT locate the on-disk
      // deploy tree (that is `mailboxAddress`-derived, below).
      deploymentId: validated.WORKFLOW_RAW_DEPLOYMENT_ID,
      tenantId: validated.TENANT_ID,
      hubHttpUrl: wsUrlToHttp(validated.HUB_WS_URL),
      sidecarToken: validated.SIDECAR_TOKEN,
      // WORKBENCH-LOCAL (CL-2199): single-agent (stepCount === 1) tool identity
      // — the real agent-definition id + instance principal the deploy router
      // threaded from the frame. Ignored by the multi-step branch.
      singleAgentId: validated.WORKFLOW_SINGLE_AGENT_ID,
      singleAgentPrincipalId: validated.WORKFLOW_SINGLE_AGENT_PRINCIPAL_ID,
      // On-disk deploy-tree lookup: the hub stages each step's pinned tool
      // closure at `<dataDir>/<sanitizeAddress(stepAddress)>`. A single-step
      // deploy reads the tree at the head; a genuine multi-step deploy reads
      // each step at its derived address. `stepCount` is the real parsed
      // `STEP_COUNT` (`env.spawn.stepCount`) and must drive step-address
      // derivation directly — reconstructing it from `warmKeep` would
      // mislocate a multi-step deploy tree if a future pin ever set
      // `warmKeep` on a non-single-step deploy.
      dataDir: validated.SIDECAR_DATA_DIR,
      mailboxAddress: env.spawn.mailboxAddress,
      stepCount: env.spawn.stepCount,
      cacheRoot: path.join(
        validated.SIDECAR_DATA_DIR,
        "cache",
        "tool-packages",
      ),
      cacheMaxBytes,
      registryMaxTarballBytes,
    });

    // Durable-conversation registry for the warm single-step agent (upstream
    // §3c). Built only when the deployment is warm-kept: the sole long-lived
    // agent's conversation must survive child respawn, so it is mirrored to
    // the workflow-run substrate at a per-agent path. A multi-step deploy
    // leaves this `undefined` -- its per-step agents are not warm/long-lived
    // (§3b), so they carry no cross-run conversation and keep the per-run
    // isogit store. The registry lives for the child's lifetime; on respawn
    // the child rebuilds it empty and each store restores its prior snapshot
    // from the substrate on first acquire.
    const conversationSigner = createSidecarCommitSigner(signingKey);
    const durableConversation: DurableConversationRegistry | undefined = env
      .spawn.warmKeep
      ? createDurableConversationRegistry({
          dataDir: validated.SIDECAR_DATA_DIR,
          workflowRunRepoId,
          workflowRunRef: validated.WORKFLOW_RUN_REF,
          substrate,
          principal,
          signer: conversationSigner,
        })
      : undefined;

    // Run-boundary durability flush (upstream §3c). When warm-kept, mirror the
    // warm agent's conversation snapshot to the substrate after each message's
    // send settles. The key is the step identity, the same key the env builder
    // filed the durable store under and the warm cache keys by. Absent for a
    // multi-step deploy.
    const onRunBoundary: ((key: string) => Promise<void>) | undefined =
      durableConversation !== undefined
        ? async (key: string) => {
            await durableConversation.get(key).mirrorToSubstrate();
          }
        : undefined;

    // Build the per-step invoker per invocation so each step's inference
    // path is wired against THIS step's host-supplied `authorize`,
    // `onEvent`, and `warmCache`. The deterministic (CL-2202) and inline
    // (CL-2251) dispatch branches live inside `createSidecarStepInvoker` and
    // are preserved; upstream's `createWorkflowStepInvoker` (warm/cold path)
    // layers under the inference branch only.
    const buildStepInvoker = (
      workflowAuthorize: WorkflowAuthorizeFn,
      onEvent: (event: InferenceEvent) => void,
      warmCache: WarmAgentCache | undefined,
    ): StepInvoker =>
      createSidecarStepInvoker({
        table: stepInferenceSources,
        dataDir: validated.SIDECAR_DATA_DIR,
        workflowRunRepoId,
        signer: conversationSigner,
        directors: createWorkbenchDirectorRegistry(),
        adapters: childAdapterRegistry,
        evaluateGrants: evaluateGrantsAdapter,
        workflowAuthorize,
        onEvent,
        outboundMailBridge: env.outboundMailBridge,
        mailboxAddress: env.spawn.mailboxAddress,
        // WORKBENCH-LOCAL: a warm single-step deployment (Myra/Oat/triage/gate)
        // gets per-agent director resolution + dynamic tools in the step
        // factory; a multi-step step keeps the budget director unconditionally.
        warmKeep: env.spawn.warmKeep,
        ...(warmCache !== undefined ? { warmCache } : {}),
        ...(durableConversation !== undefined ? { durableConversation } : {}),
        ...(onRunBoundary !== undefined ? { onRunBoundary } : {}),
        // A test-injected agentFactory takes precedence (pure-inference path);
        // otherwise the production tool-capable factory is wired from the
        // tool-context resolver inside createSidecarStepInvoker.
        ...(deps.agentFactory !== undefined
          ? { agentFactory: deps.agentFactory }
          : { resolveStepToolContext }),
      });

    // Child-runtime step invoker. The in-process `runChild` (see
    // `createSidecarRunChild` below) runs a separate WorkflowDefinition
    // whose stepIds are disjoint from the parent's, so the parent's
    // `STEP_INFERENCE_SOURCES`-driven `buildStepEnv` would throw on
    // every child stepId ("no InferenceSource pinned"). The
    // `STEP_INFERENCE_SOURCES` table the supervisor threads in is the
    // PARENT definition's per-step source map; child definitions carry
    // their own per-step sources that are not pinned into this child
    // process's env. Until child per-step sources are threaded through
    // the spawn seam, the child invoker keeps the upstream stub's
    // success output rather than crashing every nested-workflow step on
    // a "no InferenceSource pinned" lookup miss. Real inference for the
    // PARENT's steps (the must-have) is wired above.
    const childInvokeStep: StepInvoker = (req) =>
      Promise.resolve({ output: { reply: req.agent.id, turn: null } });

    // Adapt the workflow-runtime `StepInvoker` shape onto the host's
    // `ChildStepInvoker` (4-arg) shape. `onEvent` is the per-step
    // inference event sink and `authorize` is the runtime's
    // credentials-backed authorize closure; both are threaded into the
    // per-step invoker built for THIS invocation so the inference path
    // gates each tool call against the step's grant snapshot and forwards
    // its events.
    //
    // `warmCache` (upstream §3b) is the run-loop's per-deployment warm-agent
    // cache, present only for the warm-kept single-step deployment. Threaded
    // into the per-step invoker so the inference branch builds the agent once
    // and reuses it across messages (with the run-boundary durability flush
    // mirroring its conversation to the substrate after each send); absent it
    // keeps instantiate-send-teardown per step. The deterministic (CL-2202)
    // and inline (CL-2251) branches never warm-keep -- they are pure
    // tool/single-turn dispatch with no reactor to keep alive.
    const invokeStep: RunWorkflowChildBindings["invokeStep"] = async (
      req,
      onEvent,
      authorize,
      warmCache,
    ) => buildStepInvoker(authorize, onEvent, warmCache)(req);

    const runChild = createSidecarRunChild({
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      workflowDefinitionRef: validated.WORKFLOW_DEFINITION_REF,
      principal,
      scheduler,
      invokeStep: childInvokeStep,
    });

    const spawnChild = createWorkflowSpawnChild({
      substrate,
      principal,
      deployRef: validated.WORKFLOW_DEFINITION_REF,
      runChild,
    });

    // Per-run scratch reclamation for the cold (multi-step) path. The
    // run-loop fires this once each run reaches its terminal status; it
    // drops the run's whole `workflow-step-state/<repoId>/runs/<runId>/`
    // subtree (every step/attempt the run produced) via `runStepStorageRoot`.
    // `rm -rf` semantics (recursive + force) so a run that never wrote
    // scratch is a no-op rather than an ENOENT throw.
    //
    // Parked-step safety: reclamation keys on the RUN's terminal status, and
    // a step parked on a signal (`awaiting-signal`) keeps the run
    // non-terminal, so this never fires while a suspended step's `attempt-N`
    // store still holds a live pending-op the crash-resume path must reopen
    // (the keying the `createSidecarStepBuildEnv` resume assertion depends
    // on). Any future per-STEP reclamation must preserve that invariant.
    //
    // The warm single-step path keys its agent scratch STABLY under the
    // disjoint `warm/<stepId>/` sub-root (see `warmStepStorageRoot`), reused
    // across every message and NOT reclaimed per run -- the cached agent is
    // long-lived. Its whole subtree is reclaimed on undeploy by the
    // workflow-host-wiring undeploy hook, which removes the entire
    // `workflow-step-state/<deploymentId>/` tree (both `runs/` and `warm/`)
    // once the supervisor + child are torn down. So the warm branch leaves
    // `cleanupRunStorage` undefined here -- the per-run sweep must not touch
    // the stable warm workspace, and the undeploy hook owns its reclamation.
    // The durable conversation under `agent-conversation-state/` is a
    // different root neither sweep touches, so a re-deploy resumes it.
    const cleanupRunStorage: ((runId: string) => Promise<void>) | undefined =
      env.spawn.warmKeep
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

    // Native `action` steps carry no `agent`, so they never reach
    // `buildStepInvoker`/`invokeStep` above — the runtime dispatches them
    // through the SEPARATE `ActionInvoker` seam (`@intx/workflow`'s
    // `createWorkflowActionInvoker`), which this `resolveActionHandler`
    // binding resolves `handler` refs for. Every action step's tool
    // closure is resolved EAGERLY here, before the child establishes: the
    // workflow-definition repo's working tree (`workflowDefinitionRepoId`
    // on `substrate`) is already materialized at this point in establish —
    // the same tree `packages/workflow-host`'s `loadWorkflowDefinition`
    // reads moments later — so a missing tool package or an unconfigured
    // tenant credential fails now, not at the action's first dispatch deep
    // into an unattended run. Wired unconditionally: an action-free
    // deployment enumerates zero action steps and resolves nothing.
    const resolveActionHandler = await createActionToolHandlerRegistry({
      dataDir: validated.SIDECAR_DATA_DIR,
      substrate,
      workflowDefinitionRepoId,
      resolveStepToolContext,
      outboundMailBridge: env.outboundMailBridge,
      mailboxAddress: env.spawn.mailboxAddress,
    });

    const bindings: RunWorkflowChildBindings = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      principal,
      workflowDefinitionRepoId,
      workflowDefinitionRef: validated.WORKFLOW_DEFINITION_REF,
      invokeStep,
      spawnChild,
      resolveActionHandler,
      scheduler,
      evaluateGrants: evaluateGrantsAdapter,
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
export const createSubstrate: SubstrateFactory =
  createSidecarSubstrateFactory();
