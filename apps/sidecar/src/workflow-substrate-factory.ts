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
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  createStepAgentFactory,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";
import { wsUrlToHttp } from "./agent-tools";
import {
  DEFAULT_REGISTRY_MAX_TARBALL_BYTES,
  DEFAULT_TOOL_CACHE_MAX_BYTES,
} from "./config";
import type {
  Agent,
  AgentDefinition,
  BaseEnv,
  DirectorRegistry,
} from "@intx/agent";
import { createAgent, createDefaultDirectorRegistry } from "@intx/agent";
import { createSSHSignature } from "@intx/crypto-node";
import { createIsogitStore, type CommitSigner } from "@intx/storage-isogit";
import { createWorkbenchDirectorRegistry } from "@workbench/agents";
import {
  createAgentRepoStore,
  type Principal,
  type RepoId,
  type RepoStore,
  type WorkflowRunWorkflowProcessPrincipal,
} from "@intx/hub-sessions";
import {
  adaptHostScheduler,
  createProxyWorkflowRunRepoStore,
  createWorkflowHostScheduler,
  createWorkflowRunBlobSubstrate,
  createWorkflowRunRepoStore,
  createWorkflowHostSignalChannel,
  createWorkflowSpawnChild,
  createWorkflowStepInvoker,
  type GrantEvaluator,
  type RunChildWorkflow,
  type RunWorkflowChildBindings,
  type StepEnvBase,
  type SubstrateFactory,
  type SubstrateFactoryEnv,
} from "@intx/workflow-host";
import {
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
  // INTENTIONAL DIVERGENCE FROM UPSTREAM: the reference sidecar's substrate
  // config carries no TENANT_ID. GTM Workbench threads it so the per-step
  // tool-context resolver can scope hub manifest/credential lookups to the
  // deploying tenant. Pin-bump re-diffs: this key is ours; keep it.
  "TENANT_ID",
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
  TENANT_ID: "string > 0",
}).onUndeclaredKey("ignore");

/**
 * Per-step `InferenceSource` table parsed from the spawn-time
 * `STEP_INFERENCE_SOURCES` env entry. The deploy router serializes
 * `frame.workflow.sources` (a `Record<stepId, InferenceSource>`) as
 * JSON and threads it through the supervisor's `substrateEnv`; the
 * factory parses and validates the table once at construction time
 * and pins it for `buildEnv` lookups.
 */
const StepInferenceSourceTable = type({
  "[string]": InferenceSource,
});
type StepInferenceSourceTable = typeof StepInferenceSourceTable.infer;

/**
 * Parse and validate the JSON-encoded `STEP_INFERENCE_SOURCES` entry
 * the supervisor threaded through `substrateEnv`. A malformed JSON
 * payload, a non-object root, or a value that does not match
 * `Record<string, InferenceSource>` is rejected at the boundary with
 * a structured error rather than being deferred to a deep-stack
 * `buildEnv` failure.
 */
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

/**
 * Resolve the per-step `InferenceSource` pinned at factory
 * construction. The supervisor's multi-step branch only invokes a
 * step whose `stepId` appears in `frame.workflow.sources`; a lookup
 * miss here is a programmer error in the supervisor, not a wire-side
 * failure, and the resolver surfaces it with the missing `stepId`
 * named.
 */
function createStepInferenceSourceResolver(
  table: StepInferenceSourceTable,
): (stepId: string) => InferenceSource {
  return (stepId: string): InferenceSource => {
    const source = table[stepId];
    if (source === undefined) {
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: no InferenceSource pinned for stepId ${JSON.stringify(stepId)}; the supervisor must populate frame.workflow.sources for every stepOrder entry`,
      );
    }
    return source;
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
 * Per-step agent-harness env slots the sidecar's substrate factory
 * allocates. Pulled out of `createSidecarSubstrateFactory` so the
 * env-construction is observable in isolation; the closure pins the
 * parsed per-step source table, the per-run data root, the commit
 * signer, and the director registry once, then derives every other
 * `StepEnvBase` slot per step.
 *
 * INTENTIONAL DIVERGENCE FROM UPSTREAM: interchange's reference
 * sidecar ships a throwing-Proxy stub for `storage`/`audit`/`workdir`/
 * `directors` and a stub step invoker that never builds a real agent.
 * GTM Workbench wires the real harness here so workflow steps run real
 * inference. Each slot mirrors the live-agent path in `default-harness.ts`
 * (cited per slot) so a workflow step's agent gets the same context
 * store, audit sink, workspace, and director registry a chat agent does.
 * Future pin-bump re-diffs: this block is ours, not upstream's stub.
 */
function createSidecarStepBuildEnv(args: {
  table: StepInferenceSourceTable;
  dataDir: string;
  signer: CommitSigner;
  directors: DirectorRegistry;
  /**
   * Per-step tool context resolver. Omitted by tests that exercise pure
   * inference; production supplies it so the step env carries the hub
   * connection + grants the tool-capable agentFactory reads back.
   */
  resolveStepToolContext?: (req: StepInvokeRequest) => Promise<StepToolContext>;
}): (req: StepInvokeRequest) => Promise<StepEnvBase> {
  const resolveStepInferenceSource = createStepInferenceSourceResolver(
    args.table,
  );
  return async (req: StepInvokeRequest): Promise<StepEnvBase> => {
    const stepId = req.authzContext.stepId;
    if (stepId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.stepId is required for per-step InferenceSource resolution; the workflow runtime must populate stepId on every step-originated invocation",
      );
    }
    const source = resolveStepInferenceSource(stepId);

    // Per-run/per-step storage root under SIDECAR_DATA_DIR, keyed by
    // runId + stepId so concurrent steps never share an isogit lock
    // boundary. The runId comes from the workflow runtime's
    // AuthorizeContext; a step-originated invocation always carries it.
    const runId = req.authzContext.runId;
    if (runId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.runId is required to allocate a per-run step storage root; the workflow runtime must populate runId on every step-originated invocation",
      );
    }
    const attempt = req.authzContext.attempt ?? 1;
    const storeDir = path.join(
      args.dataDir,
      "workflow-steps",
      sanitizePathSegment(runId),
      `${sanitizePathSegment(stepId)}-attempt-${String(attempt)}`,
    );
    await fs.promises.mkdir(storeDir, { recursive: true });

    // `storage`: per-step isogit context store. Mirrors default-harness
    // `const storage = await createIsogitStore(storeDir, signer)`.
    const storage = await createIsogitStore(storeDir, args.signer);
    // `audit`: default-harness uses the isogit store as the agent's
    // ContextStore AND a separate mail-audit store (`createMailAuditStore`).
    // The agent harness's BaseEnv.audit is the AuditStore; default-harness
    // passes `audit: storage` in its env literal, so we match that and
    // route the agent's audit records into the same per-step isogit store.
    const audit = storage;

    // `workdir`: per-step workspace dir, mkdir'd recursively. Mirrors
    // default-harness `const workDir = path.join(storeDir, 'workspace');
    // await fs.promises.mkdir(workDir, { recursive: true })`.
    const workdir = path.join(storeDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });

    const env: StepEnvBase & Record<string, unknown> = {
      sources: [source],
      defaultSource: source.id,
      storage,
      workdir,
      audit,
      // `directors`: default-harness uses `createWorkbenchDirectorRegistry()`.
      directors: args.directors,
    };

    // Stash the per-step tool context so the tool-capable agentFactory can
    // materialize the step's pinned tool packages + credentials + grants.
    // Pure-inference tests omit the resolver; the agentFactory they pair
    // never reads the key.
    if (args.resolveStepToolContext !== undefined) {
      env[STEP_TOOL_CONTEXT_KEY] = await args.resolveStepToolContext(req);
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
  deploymentId: string;
  stepId: string;
}): Promise<GrantRule[]> {
  const repoId: RepoId = {
    kind: "agent-state",
    id: `${args.deploymentId}-${args.stepId}`,
  };
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- grants.json holds the sidecar's GrantRule grammar, validated as unknown[] at the boundary
  return validated.grants as GrantRule[];
}

/**
 * Inputs the production step tool-context resolver closes over. The
 * deploymentId comes from the spawn env; the hub-connection anchors come
 * from the validated substrate config.
 */
export interface StepToolContextResolverArgs {
  bareStore: RepoStore;
  deploymentId: string;
  tenantId: string;
  hubHttpUrl: string;
  sidecarToken: string;
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
    // Must stay identical to `@intx/workflow-deploy`'s exported
    // `deriveStepAgentId` (`ins_<deploymentId>-<stepId>`), which the hub's
    // `writeStepAgentRows` uses to persist the row this id resolves. The
    // template is hand-rolled here (not imported) because `@intx/workflow-deploy`
    // is not a sidecar dependency; on any change to that helper, update this.
    const stepAgentId = `ins_${args.deploymentId}-${stepId}`;
    let grants: GrantRule[];
    try {
      grants = await readStepGrants({
        bareStore: args.bareStore,
        deploymentId: args.deploymentId,
        stepId,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn`step tool-context: failed to read grants for ${stepAgentId}, falling back to deny-all: ${reason}`;
      grants = [];
    }
    return {
      hubHttpUrl: args.hubHttpUrl,
      sidecarToken: args.sidecarToken,
      tenantId: args.tenantId,
      stepAgentId,
      stepAddress: stepAgentId,
      principalId: stepAgentId,
      grants,
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
  signer: CommitSigner;
  directors: DirectorRegistry;
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
}): StepInvoker {
  return createWorkflowStepInvoker({
    workflowAuthorize: createSidecarStepWorkflowAuthorize(args.evaluateGrants),
    buildEnv: createSidecarStepBuildEnv({
      table: args.table,
      dataDir: args.dataDir,
      signer: args.signer,
      directors: args.directors,
      ...(args.resolveStepToolContext !== undefined
        ? { resolveStepToolContext: args.resolveStepToolContext }
        : {}),
    }),
    // The step's `req.agent.toolFactories` are walk-only stubs; the
    // tool-capable factory ignores them and builds the real runner from the
    // step's pins. A test-injected `agentFactory` (pure inference) is wired
    // verbatim instead.
    agentFactory:
      args.agentFactory ??
      (args.resolveStepToolContext !== undefined
        ? createStepAgentFactory()
        : createAgent),
  });
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- credentialsSnapshot.steps[*].grants is typed unknown[] at the workflow-host boundary; the sidecar owns the GrantRule grammar
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

    // INTENTIONAL DIVERGENCE FROM UPSTREAM REFERENCE SIDECAR.
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
      deploymentId: env.spawn.deploymentId,
      tenantId: validated.TENANT_ID,
      hubHttpUrl: wsUrlToHttp(validated.HUB_WS_URL),
      sidecarToken: validated.SIDECAR_TOKEN,
      cacheRoot: path.join(
        validated.SIDECAR_DATA_DIR,
        "cache",
        "tool-packages",
      ),
      cacheMaxBytes: DEFAULT_TOOL_CACHE_MAX_BYTES,
      registryMaxTarballBytes: DEFAULT_REGISTRY_MAX_TARBALL_BYTES,
    });

    const baseInvokeStep: StepInvoker = createSidecarStepInvoker({
      table: stepInferenceSources,
      dataDir: validated.SIDECAR_DATA_DIR,
      signer: createSidecarCommitSigner(signingKey),
      directors: createWorkbenchDirectorRegistry(),
      evaluateGrants: evaluateGrantsAdapter,
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
    // `ChildStepInvoker` shape. The wrapper today drops `onEvent` --
    // the production step-invoker adapter does not yet thread an
    // event firehose through the harness's send path; the event
    // funnel inside the adapter lands when the harness's emit hook is
    // wired. Holding the parameter at this boundary keeps the seam
    // explicit so the wire-up is a single point of edit.
    const invokeStep: RunWorkflowChildBindings["invokeStep"] = async (
      req,
      onEvent,
    ) => {
      void onEvent;
      return baseInvokeStep(req);
    };

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

    const bindings: RunWorkflowChildBindings = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      principal,
      workflowDefinitionRepoId,
      workflowDefinitionRef: validated.WORKFLOW_DEFINITION_REF,
      invokeStep,
      spawnChild,
      scheduler,
      evaluateGrants: evaluateGrantsAdapter,
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
