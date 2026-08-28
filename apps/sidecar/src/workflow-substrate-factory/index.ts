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

import { type } from "arktype";

import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import {
  builtinCredentialProviders,
  createCredentialProviderRegistry,
  driveConnectorReplies,
  type AgentEventStream,
  type ConnectorReplyDrain,
} from "@intx/harness";
import {
  createHttpRawAuthorizationCredentialProvider,
  createHttpXApiKeyCredentialProvider,
  createMcpStreamableHttpCredentialProvider,
} from "@corbits/credential-providers";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { createSSHSignature } from "@intx/crypto";
import {
  createAgentRepoStore,
  type RepoStore,
  type WorkflowRunWorkflowProcessPrincipal,
} from "@intx/hub-sessions/substrate";
import {
  adaptHostScheduler,
  createProxyWorkflowRunRepoStore,
  createWorkflowHostScheduler,
  createWorkflowStepInvoker,
  type GrantEvaluator,
  type LoadParkedApproval,
  type RunWorkflowChildBindings,
  type SubstrateFactory,
  type SubstrateFactoryEnv,
  createChildMailboxReader,
  createMailboxWatchRegistry,
  type SupervisorBackedTransportInbound,
} from "@intx/workflow-host";
import { type ReadParkedApprovalOps, type StepInvoker } from "@intx/workflow";
import type { InboundMessage } from "@intx/types/runtime";

import {
  createToolBearingAgentFactory,
  type StepToolCacheConfig,
} from "../step-agent-tools";
import {
  createDurableConversationRegistry,
  type DurableConversationRegistry,
} from "../conversation-state";
import { parseToolRegistries } from "../tool-materialization";
import {
  deriveHubHttpUrl,
  parseAdapterManifest,
  parseByteCap,
  parseStepInferenceSources,
  SIDECAR_SUBSTRATE_CONFIG_KEYS,
  SubstrateConfig,
} from "./config";
import { runStepStorageRoot } from "./storage-paths";
import {
  readColdParkedApprovalSnapshot,
  readColdParkedPendingOperations,
  readWarmParkedApprovalSnapshot,
  readWarmParkedPendingOperations,
  toParkedApprovalOps,
} from "./parked-approvals";
import { createSidecarStepBuildEnv } from "./step-env";

export { createSidecarStepBuildEnv };
export { type SidecarStepBuildEnvDeps } from "./step-env";
import {
  createSidecarRunChild,
  createSidecarSpawnSuspendableChild,
  type SidecarBodyStepInvoker,
  type SidecarRunChildDeps,
} from "./child-runtime";

export {
  createSidecarRunChild,
  createSidecarSpawnSuspendableChild,
  type SidecarBodyStepInvoker,
};

export { parseAdapterManifest, SIDECAR_SUBSTRATE_CONFIG_KEYS };

// The child does not construct a workflow-run pack-push pipeline of
// its own. The supervisor owns the workflow-run repo's write
// contract; the supervisor's substrate is wrapped at the sidecar's
// boot edge with the pack-pushing facade so any successful workflow-
// run write fires the hub push automatically. The child's proxy
// `RepoStore` forwards `writeTreePreservingPrefix` over IPC into the
// supervisor's wrapped substrate.

/**
 * Thrown by the child-runtime step invoker when a `childWorkflow` (or a
 * `map` nested inside one) reaches a per-step agent invocation. Real
 * per-step child execution -- threading the child
 * `WorkflowDefinition`-derived inference sources, tools, and grants into
 * a real agent, backed by deploy-side child asset staging and capability
 * approval -- is not yet built.
 *
 * Failing here is deliberate. Returning a fabricated success output would
 * report a child run `completed` whose agent never ran, a silent
 * correctness trap; a loud, structured failure is the honest behavior for
 * an unbuilt seam.
 */
export class ChildStepNotImplementedError extends Error {
  constructor(agentId: string, stepId: string | undefined) {
    super(
      `childWorkflow per-step execution is not implemented; ` +
        `the child runtime cannot run a real per-step agent for step ${JSON.stringify(stepId)} (agent ${JSON.stringify(agentId)})`,
    );
    this.name = "ChildStepNotImplementedError";
  }
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
}

/**
 * `CommitSigner` the per-step isogit stores use to sign every commit.
 * The factory's Ed25519 signing keypair (the same key the child's bare
 * `RepoStore` carries) is bound into an `sshsig`-shaped signer so the
 * per-step agent-state commits are attributable to the sidecar's
 * substrate identity, matching the signing surface the production
 * `RepoStore` uses for workflow-run writes.
 */
function createStepStorageSigner(signingKey: {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}): (payload: string) => Promise<string> {
  return (payload: string) =>
    Promise.resolve(
      createSSHSignature(payload, signingKey.privateKey, signingKey.publicKey),
    );
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
    const childAdapterRegistry = await loadAdapterRegistry(
      parseAdapterManifest(validated.SIDECAR_ADAPTER_MANIFEST),
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
      cacheMaxBytes: parseByteCap(
        validated.SIDECAR_CACHE_MAX_BYTES,
        "SIDECAR_CACHE_MAX_BYTES",
      ),
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
    // Durable-conversation registry for the warm single-step agent.
    // Built only when the deployment is warm-kept: the
    // sole long-lived agent's conversation must survive child respawn,
    // so it is mirrored to the workflow-run substrate at a per-agent
    // path. A multi-step deploy leaves this `undefined` -- its per-step
    // agents are not warm/long-lived, so they carry no cross-run
    // conversation and keep the per-run isogit store. The registry lives
    // for the child's lifetime; on respawn the child rebuilds it empty
    // and each store restores its prior snapshot from the substrate on
    // first acquire.
    const conversationSigner = createStepStorageSigner(signingKey);
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

    // INBOUND half of mailbox ownership. One watch registry per child,
    // shared by the step agent's supervisor-backed transport (its `watch`
    // registers callbacks here, backing `mail_wait`) and the child's control
    // loop (which fires each `mailbox.notify` into it); it rides out on the
    // bindings so `runWorkflowChild` routes notifications to this instance.
    // The reader opens a fresh committed snapshot of the deployment's
    // substrate `INBOX` per read, so a read after a `mailbox.notify` sees the
    // message the supervisor just committed. Every step env -- top-level or
    // onTrigger body -- gets the surface, since the fork's bodies are
    // tool-bearing agents.
    const mailboxWatchRegistry = createMailboxWatchRegistry();
    const transportInbound: SupervisorBackedTransportInbound = {
      reader: createChildMailboxReader({
        substrate,
        repoId: workflowRunRepoId,
        principal,
        ref: validated.WORKFLOW_RUN_REF,
      }),
      watchRegistry: mailboxWatchRegistry,
      // The child holds no sender-key registry, so `fetchFull` reports every
      // message's signature status as "unknown".
      getCrypto: () => undefined,
      // Flag/expunge writes ride to the supervisor, the sole mailbox writer.
      mutationBridge: env.mailboxMutationBridge,
    };

    const buildStepEnvBaseOpts = {
      dataDir: validated.SIDECAR_DATA_DIR,
      workflowRunRepoId,
      signer: conversationSigner,
      registries: parseToolRegistries(validated.SIDECAR_TOOL_REGISTRIES),
      mailboxAddress: env.spawn.mailboxAddress,
      stepCount: env.spawn.stepCount,
      outboundMailBridge: env.outboundMailBridge,
      inbound: transportInbound,
      cache: stepToolCache,
      adapters: childAdapterRegistry,
      hubArtifactsUrl: deriveHubHttpUrl(validated.HUB_WS_URL),
      sidecarToken: validated.SIDECAR_TOKEN,
      definitionId: validated.WORKFLOW_DEFINITION_ID,
    };
    const buildStepEnv = createSidecarStepBuildEnv(
      durableConversation !== undefined
        ? { ...buildStepEnvBaseOpts, durableConversation }
        : buildStepEnvBaseOpts,
    );

    // Credential provider registry: the platform's built-in `http`
    // (Bearer) provider (`@intx/harness`'s `builtinCredentialProviders`)
    // plus this workbench's own `http-raw-authorization` plugin (for a
    // provider row whose API expects the raw secret in `authorization`
    // with no `Bearer ` prefix -- Linear's convention) and
    // `http-x-api-key` plugin (for a provider row whose API expects the
    // secret in an `x-api-key` header -- Exa's and ScrapeCreators'
    // convention), both from `@corbits/credential-providers` rather than
    // forking or reaching around the vendored plugin. Fixed for the
    // child's lifetime -- unlike the per-step wiring below, the set of
    // provider plugins is not something a rotation or
    // `credentials-updated` frame changes.
    const credentialProviders = createCredentialProviderRegistry([
      ...builtinCredentialProviders(),
      createHttpRawAuthorizationCredentialProvider(),
      createHttpXApiKeyCredentialProvider(),
      createMcpStreamableHttpCredentialProvider(),
    ]);

    // The tool-bearing agent factory reads the materialized tool
    // runtime off the per-step env (set by `buildStepEnv` via
    // `attachStepTools`), attaches the loaded tool factories to the
    // step's `AgentDefinition`, builds the plugin chain on
    // `env.plugins`, and wraps `agent.close()` so every plugin (the LSP
    // subprocess included) and tool bundle is torn down with the agent
    // on every exit path. It also shapes a consumer-scoped `credentials`
    // capability for any tool package that declares one, reading the
    // per-step `CredentialWiring` `buildStepEnv` attached to the env
    // (see `attachStepCredentials`). The factory is stateless across
    // steps, so it is pinned once here and shared by every per-step
    // invoker built below.
    const stepAgentFactory = createToolBearingAgentFactory({
      providers: credentialProviders,
    });

    // Child-runtime step invoker. The in-process `runChild` (see
    // `createSidecarRunChild` below) runs a separate WorkflowDefinition
    // whose stepIds are disjoint from the parent's, and deploy does not
    // stage the child definition's per-step assets (inference sources,
    // tool trees) or walk its capabilities. Running a real per-step agent
    // for a `childWorkflow` / `map` fan-out step is therefore not
    // implemented yet. The `authorize`
    // argument -- the child's credentials-backed authorize -- is unused
    // here for the same reason: no agent runs to gate.
    //
    // This is a deliberate hard stop, not a fabricated result. A fake
    // success output (the shape this once returned) reported a child run
    // `completed` whose agent never ran -- a silent correctness trap.
    // Failing loudly surfaces the child step as `StepFailed` with a
    // structured error instead. The `spawnChild` /
    // `runChild` recursion and the sub-namespace scoping around it are
    // real and exercised right up to this seam.
    const childInvokeStep: StepInvoker = (req) =>
      Promise.reject(
        new ChildStepNotImplementedError(req.agent.id, req.authzContext.stepId),
      );

    // onTrigger BODY step invoker (CL-6448). Unlike a childWorkflow child,
    // an onTrigger section body IS staged: its definition and per-step
    // inference sources land on disk beside each other at deploy. A body
    // agent step runs for real through the same `createWorkflowStepInvoker`
    // and the same `buildStepEnv` the top level uses -- so a warm-kept
    // section deployment's body turns share the per-agent durable
    // conversation store (each turn's agent loads every prior turn, keyed
    // by the body's stable stepId across `turn__<n>` occurrences) and
    // materialize the deployment's staged tool manifest (the head/step
    // collapse reads the folded launch's own staged pins for a single-step
    // deployment). The agent itself stays cold per occurrence; the mirror
    // in the `finally` below is the body path's run-boundary durability
    // flush, matching the warm top-level path's `onRunBoundary`. The
    // per-body `sourcesRef` is threaded in per spawn, disjoint from the
    // top level's. `onEvent` is the per-run event funnel from the parent
    // run's event channel, so a body agent's live inference events reach
    // the hub stream (per-run attribution stays durable via
    // runs/<childRunId>/events/).
    const bodyInvokeStep: SidecarBodyStepInvoker = async (
      req,
      authorize,
      sourcesRef,
      onEvent,
      credentialWiring,
      mailPartReader,
    ) => {
      try {
        return await createWorkflowStepInvoker({
          workflowAuthorize: authorize,
          buildEnv: (buildReq) =>
            buildStepEnv(buildReq, sourcesRef, credentialWiring),
          agentFactory: stepAgentFactory,
          sourcesRef,
          onEvent,
          ...(mailPartReader !== undefined ? { mailPartReader } : {}),
        })(req);
      } finally {
        const bodyStepId = req.authzContext.stepId;
        if (durableConversation !== undefined && bodyStepId !== undefined) {
          // `peek`, not `get`: a build failure before the env's acquire
          // must surface as itself, not as the registry's missing-store
          // throw.
          await durableConversation.peek(bodyStepId)?.mirrorToSubstrate();
        }
      }
    };

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
    // The `warmCache` is the run-loop's per-deployment
    // warm-agent cache, present only for the single-step long-lived
    // deployment the deploy projection marked a warm candidate. When
    // supplied, the adapter builds the agent once and reuses it across
    // messages; when absent, it keeps instantiate-send-teardown per
    // step. Forwarding it here is the only warm-keep wiring this binding
    // needs -- the adapter and the run-loop own the rest of the
    // lifecycle.
    // Run-boundary durability flush. When the deployment is
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

    // Connector-thread seed: when the deployment is warm-kept, route each
    // mail-derived inbound message onto the warm agent's connector thread
    // before its send, so the reply path has thread state. Keyed by the step
    // identity the durable store is filed under.
    const seedInbound =
      durableConversation !== undefined
        ? async (key: string, message: InboundMessage) => {
            await durableConversation.get(key).seedInbound(message);
          }
        : undefined;

    // Connector reply drain: on each `connector.reply` the warm agent emits,
    // compose a threaded reply from the durable store's connector thread,
    // send it through the outbound bridge (the same signed-send path the
    // agent's own transport uses) and advance the thread from the receipt.
    // The References chain comes from the committed mailbox: the parent's
    // own References plus its Message-Id; a parent miss (first reply on a
    // fresh thread) leaves the transport to derive [inReplyTo].
    const driveReplies =
      durableConversation !== undefined
        ? (key: string, stream: AgentEventStream): ConnectorReplyDrain =>
            driveConnectorReplies({
              stream,
              composeReply: () => durableConversation.get(key).composeReply(),
              send: (message) =>
                env.outboundMailBridge.submit(
                  env.spawn.mailboxAddress,
                  message,
                ),
              resolveReferences: async (inReplyTo) => {
                const store = await transportInbound.reader.open();
                const parent = store.messages.find(
                  (m) => m.envelope.messageId === inReplyTo,
                );
                return parent === undefined
                  ? undefined
                  : [...parent.envelope.references, parent.envelope.messageId];
              },
              onReplySent: (receipt) =>
                durableConversation.get(key).onReplySent(receipt),
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
        buildEnv: (buildReq: Parameters<typeof buildStepEnv>[0]) =>
          buildStepEnv(buildReq, sourcesRef, credentialWiring),
        agentFactory: stepAgentFactory,
        onEvent,
        sourcesRef,
        mailPartReader,
        ...(warmCache !== undefined ? { warmCache } : {}),
        ...(onRunBoundary !== undefined ? { onRunBoundary } : {}),
        ...(seedInbound !== undefined ? { seedInbound } : {}),
        ...(driveReplies !== undefined ? { driveReplies } : {}),
      })(req);

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
        // Boundary type assertion: credentialsSnapshot.steps[*].grants is typed unknown[] at the workflow-host boundary; the sidecar owns the GrantRule grammar
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

    const childRunDeps: SidecarRunChildDeps = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: validated.WORKFLOW_RUN_REF,
      principal,
      scheduler,
      invokeStep: childInvokeStep,
      // The onTrigger body path runs real agent steps; the childWorkflow
      // path (and a body's childWorkflow grandchildren) stay on `invokeStep`.
      bodyInvokeStep,
      dataDir: validated.SIDECAR_DATA_DIR,
    };
    // Terminal childWorkflow executor. `run-child` builds the in-memory
    // resolver from this plus the lifted-body map it extracts after loading
    // the parent's re-verified definition, so an owned inline child spawns
    // with no on-disk asset read.
    const runChild = createSidecarRunChild(childRunDeps);

    // An onTrigger section runs each event's body as a suspendable child.
    // `run-child` builds the in-memory body resolver from this raw executor
    // plus the lifted-body map it extracts after re-evaluating the parent's
    // closure, so a body resolves in-process with no on-disk read and no
    // separate per-body re-verify -- the parent's re-verify already covers
    // every inline body.
    const runSuspendableChild =
      createSidecarSpawnSuspendableChild(childRunDeps);

    // Per-run scratch reclamation for the cold (multi-step) path. The
    // run-loop fires this once each run reaches its terminal status; it
    // drops the run's whole `workflow-step-state/<repoId>/runs/<runId>/`
    // subtree (every step/attempt the run produced), which nothing
    // reopens after terminal (resume reads the substrate run log, not
    // local step state). Built only for the cold path: a warm deploy
    // roots its single agent's scratch per agent under the disjoint
    // `warm/` sub-root (reclaimed on undeploy), and the run-loop's own
    // `warmKeep` gate already suppresses the per-run call there, so
    // leaving this undefined for warm deploys keeps the path-owning
    // module's intent explicit. `rm -rf` semantics via `recursive +
    // force` so a run that never wrote scratch (no buildEnv reached) is
    // a no-op rather than an ENOENT throw.
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

    // Recover a parked correlation's approval snapshot for the child's
    // re-registration enumeration (ported from upstream Interchange's
    // sidecar at the vendored pin). Wired unconditionally (unlike
    // `cleanupRunStorage`, which is cold-only): a warm agent parks on
    // approval just as a cold one does, and the branch on `warmKeep`
    // selects the durable read — cold reads the per-attempt isogit
    // store, warm reconstructs the agent's durable conversation state
    // from the substrate.
    const loadParkedApproval: LoadParkedApproval = ({
      runId,
      stepId,
      attempt,
      correlationId,
    }) =>
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

    // Enumerate a crashed step's durable pending approval operations for
    // the resume classifier, off the same cold/warm durable read as
    // `loadParkedApproval`. Where that binding is a lookup by a known
    // correlationId (answering the supervisor's re-registration), this is
    // the enumeration the classifier needs when the correlationId never
    // reached the log — the crash-across-park case.
    const readParkedApprovalOps: ReadParkedApprovalOps = async ({
      runId,
      stepId,
      attempt,
    }) =>
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
      scheduler,
      evaluateGrants: evaluateGrantsAdapter,
      loadParkedApproval,
      readParkedApprovalOps,
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
export const createSubstrate: SubstrateFactory =
  createSidecarSubstrateFactory();
