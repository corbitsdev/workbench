// Thin wiring module that constructs `createWorkflowSupervisor` with
// this sidecar's host-specific bindings: the existing mail-bus
// instance, the sidecar's Ed25519 signing keypair, the substrate
// RepoStore handle, and `Bun.spawn` as the subprocess spawner. Any
// logic that would benefit a future alternative-sidecar
// implementation lives inside `@intx/workflow-host`, not here.

import { rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";

import { type } from "arktype";

import { derivePublicKeyBytes } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type { HubTransport } from "@intx/mail-memory";
import { type RepoStore } from "@intx/hub-sessions";
import type {
  AgentKeyStore,
  DeployRouter,
  DeployRouterResult,
  SessionManager,
} from "@intx/hub-agent";
import {
  type DeriveStepAddress,
  type DispatchTimingMark,
  type SpawnOpts,
  type SubprocessSpawner,
  type SuspensionRegistration,
} from "@intx/workflow-host";
import { hexEncode, isRunAddress } from "@intx/types";
import {
  parseInferenceEvent,
  type CryptoProvider,
  type InferenceEvent,
  type InferenceSource,
  type KeyPair,
} from "@intx/types/runtime";
import {
  AgentDeployWorkflow,
  type AgentDeployFrame,
} from "@intx/types/sidecar";

import type {
  MultistepCredentialsRouter,
  MultistepDrainRouter,
  MultistepGrantsRouter,
  MultistepMailRouter,
  MultistepSignalRouter,
  MultistepSourcesRouter,
} from "../workflow-run-pack-client";
import {
  deleteWorkflowDeploymentRecord,
  readWorkflowDeploymentActivityMs,
  readWorkflowDeploymentRecord,
  scanWorkflowDeploymentRecords,
  writeWorkflowDeploymentActivityMarker,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "../workflow-deployment-record";
import {
  computeWireDefinitionHash,
  validateWorkflowProjection,
} from "./wire-validation";
import { defaultSubprocessSpawner } from "./transport";

export { defaultSubprocessSpawner };
import {
  createSidecarWorkflowSupervisor,
  type SidecarWorkflowSupervisor,
} from "./supervisor";

export {
  deriveSidecarMailAuditRef,
  type CreateSidecarWorkflowSupervisorOpts,
} from "./supervisor";
export { createSidecarWorkflowSupervisor, type SidecarWorkflowSupervisor };
import {
  createStepStrategy,
  deriveDeploymentId,
  writeStepGrants,
} from "./step-strategy";

export { deriveDeploymentId };
import {
  materializeWorkflowJson,
  materializeWorkflowSources,
  readWorkflowJson,
} from "./asset-materialization";

export { computeWireDefinitionHash, validateWorkflowProjection };

const logger = getLogger(["sidecar", "workflow-host-wiring"]);

/**
 * Env key the multi-step branch uses to carry each step's ordered
 * inference-source failover chain from `frame.workflow.sources` down to
 * the workflow-process child. The substrate factory's `buildEnv` reads
 * this and resolves a step's chain at step invocation, feeding it to the
 * reactor for forward-only failover; the supervisor itself is opaque to
 * the value (it is plumbed through `bindings.substrateEnv` verbatim).
 *
 * Listed here so the router and the future substrate-factory consumer
 * spell the key the same way without a magic-string trip hazard.
 */
export const STEP_INFERENCE_SOURCES_ENV_KEY = "STEP_INFERENCE_SOURCES";

/**
 * How long CL-5477's park path (and the process-exit drain) waits for a
 * supervisor's own graceful `shutdown()` (child signal + await exit) before
 * also sending SIGKILL to the child directly via `hardKillChild`. Bounds an
 * idle park's worst case to this window rather than however long a wedged
 * child's own shutdown sequencing takes.
 */
export const CHILD_KILL_ESCALATION_MS = 3000;

/**
 * Await a supervisor's graceful `shutdown()`, escalating to a direct
 * SIGKILL of its child if `shutdown()` hasn't settled within
 * `CHILD_KILL_ESCALATION_MS` -- still awaiting `shutdown()` to completion
 * either way, never abandoning it.
 */
async function shutdownSupervisorWithEscalation(
  wired: SidecarWorkflowSupervisor,
): Promise<void> {
  const timer = setTimeout(() => {
    wired.hardKillChild();
  }, CHILD_KILL_ESCALATION_MS);
  timer.unref?.();
  try {
    await wired.supervisor.shutdown();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive the supervisor's principal public key from the sidecar's
 * Ed25519 signing seed. The supervisor signs every workflow-run event
 * with this key; the multi-step branch surfaces it to the link so the
 * hub records the verifying key for the deployment's signed events.
 */
async function derivePrincipalPublicKeyHex(
  signingKeySeed: Uint8Array,
): Promise<string> {
  return hexEncode(await derivePublicKeyBytes(signingKeySeed));
}

/**
 * The sidecar's `DeployRouter` plus the boot-time restore driver. The link
 * routes `agent.deploy`/`agent.undeploy` through the `DeployRouter` surface;
 * the sidecar boot edge additionally calls `restoreWorkflowDeployments` once,
 * before connecting to the hub, to re-establish the deployments a prior
 * process persisted. The extra method is sidecar-app-only, so it rides on the
 * concrete router type rather than the shared `DeployRouter` contract.
 */
export interface SidecarDeployRouter extends DeployRouter {
  /**
   * Re-establish every persisted workflow deployment on this sidecar's local
   * substrate. Runs once at boot, before `hubLink.connect()`, so a single-step
   * head's mailbox/transport registration is live before the hub routes to it.
   * Soft-fails per deployment: a record that cannot be restored (unbuildable
   * provider, corrupt `workflow.json`, spawn failure) is logged and left on
   * disk for a later boot to retry -- it is never deleted here.
   */
  restoreWorkflowDeployments(): Promise<void>;
  /**
   * The workflow-substrate deployment addresses (`ins_dep_...`) this router
   * currently hosts a live supervisor for -- the set of addresses this
   * sidecar can route mail to. The boot edge announces these to the hub on
   * (re)connect so the hub re-registers them for routing: they are hub-minted
   * and carry no per-address key, so unlike single-agent sessions they are
   * not re-established by the challenge flow, and without this announcement
   * the hub drops their route on a WS reconnect. Reflects `deploy`/`undeploy`
   * and boot-time restore live, so a caller re-reads it per connect.
   */
  activeAddresses(): string[];
  /**
   * Process-exit drain: shut down every live supervisor so each
   * workflow-process child is released before the host exits, while
   * leaving all durable state -- deployment records and the durable
   * conversation root included -- on disk for the next boot's
   * `restoreWorkflowDeployments`. Distinct from `undeploy`, which
   * additionally reclaims the deployment's records and scratch.
   */
  shutdownAll(): Promise<void>;
}

export function createSidecarDeployRouter(deps: {
  sessions: SessionManager;
  keyStore: AgentKeyStore;
  transport: HubTransport;
  repoStore: RepoStore;
  signingKeySeed: Uint8Array;
  /**
   * Per-agent crypto factory. Receives the agent's raw key pair and
   * returns a `CryptoProvider` bound to it (production wires
   * `@intx/crypto`'s `createEd25519Crypto`). The multi-step branch
   * uses this to register the spawned single-step agent's signing key on
   * the host transport before `spawn()`, so the supervisor's outbound
   * mail path (`MailBusBindings.sendOutbound`) signs the agent's replies
   * with the AGENT's identity -- the OUTBOUND half of mailbox ownership
   * (the mailbox-ownership contract). Without this registration the spawned agent's address has no
   * `CryptoProvider` on the transport (nothing else registers one for
   * it), and an outbound send would throw "address is not registered"
   * rather than emit unsigned mail.
   */
  createAgentCrypto: (keyPair: KeyPair) => CryptoProvider;
  /**
   * Source-admission gate: throws if a step's pinned inference source
   * names a provider this sidecar cannot build. The buildable-provider
   * set is sidecar config (the boot edge's adapter registry), so this
   * admission control lives at the sidecar -- the hub is a different
   * process and cannot know a given sidecar's providers. Production wires
   * the default harness builder's `canBuildSource` verbatim, so a rejected
   * provider carries the same `"... is not registered"` message.
   *
   * Distinct from the orchestrator's operator-approval check
   * (`pickStepInferenceSource`): that gates on whether the operator
   * approved a `provider:model`; this gates on whether the provider is
   * buildable at all. A source can be approved yet unbuildable.
   */
  assertSourceBuildable: (source: InferenceSource) => void;
  /**
   * Record a `(deploymentId -> agentAddress)` mapping the boot edge's
   * workflow-run pack push facade consults when it must address an
   * outbound pack frame. Fires once per inbound `agent.deploy` frame
   * before the deployment's supervisor spawns, so the first pack push
   * the child triggers sees the mapping. Tests that do not exercise
   * the pack push path may pass a no-op.
   */
  registerDeployment: (entry: {
    deploymentId: string;
    agentAddress: string;
  }) => void;
  /**
   * Symmetric removal hook for `registerDeployment`. Fires from the
   * link's `agent.undeploy` path so the boot edge's
   * `DeploymentAddressRegistry` drops the mapping when the deployment
   * is torn down. A subsequent stale `writeTreePreservingPrefix`
   * against the dead deployment's workflow-run ref surfaces
   * structurally (`registry.resolve` returns `null`) rather than
   * silently resolving to the prior address. Tests that do not
   * exercise the pack push path may pass a no-op.
   */
  unregisterDeployment: (entry: {
    deploymentId: string;
    agentAddress: string;
  }) => void;
  /**
   * Control-plane suspension sink threaded verbatim to every deployment's
   * supervisor as `onSuspensionRegister`. Production wires this to the
   * sidecar's hub link (`HubLink.sendSignalCorrelationRegister`) so an
   * ask-rail suspension's approval snapshot reaches the hub as a
   * `signal.correlation.register` frame and the hub co-writes the run's
   * routing + approval rows. Optional so a test that does not exercise the
   * approval-park path needs no hub-link stub; omitting it in production
   * means a workflow-child ask-suspend parks with no approval ever
   * registered.
   */
  registerSuspension?: (registration: SuspensionRegistration) => void;
  /**
   * Substrate-config env keys the multi-step branch propagates into
   * the workflow-process child's spawn-time env (see
   * `SIDECAR_SUBSTRATE_CONFIG_KEYS` in `workflow-substrate-factory.ts`).
   * The router merges `STEP_INFERENCE_SOURCES` on top per multi-step
   * frame. Defaults to an empty record so a router built without
   * substrate config (e.g. a test) needs no boot-edge threading.
   */
  multistepSubstrateEnv?: Record<string, string>;
  /**
   * Subprocess spawner the multi-step branch hands to the supervisor.
   * Defaults to the production `Bun.spawn`-backed
   * `defaultSubprocessSpawner`; tests inject a deterministic mock.
   */
  multistepSubprocessSpawner?: SubprocessSpawner;
  /**
   * Optional override for the resolved `bin/workflow-child` path the
   * multi-step branch hands to the supervisor. Production wiring uses
   * the package-local default; tests inject a sentinel value so the
   * mock spawner can assert on it.
   */
  multistepBinaryPath?: string;
  /**
   * Callback the supervisor invokes for every verified InferenceEvent
   * the workflow-process child publishes. The router threads the
   * deployment's agent address plus the deploy's session id through to
   * the callback so a downstream fan-out can route each event to the
   * hub timeline keyed to the right session. The `InferenceEvent` itself
   * is sessionless; the session id rides alongside it, sourced from the
   * deploy frame's `HarnessConfig.sessionId` per deployment. It is
   * optional because a deploy frame need not carry a session id (a
   * headless deployment with no hub-side session); the sink decides what
   * an absent session id means. Defaults to a no-op; production wiring
   * supplies the event publisher.
   */
  publishWorkflowInferenceEvent?: (
    agentAddress: string,
    event: InferenceEvent,
    sessionId: string | undefined,
  ) => void;
  /**
   * Optional override for the multi-step branch's per-step mail-address
   * derivation. Defaults to `${deploymentId}-${stepId}@<deploymentDomain>`
   * derived from the frame's agent address. Tests inject a deterministic
   * factory.
   */
  multistepDeriveStepAddress?: DeriveStepAddress;
  /**
   * Per-deployment-address mail handler registry the hub-link's
   * `mail.inbound` path consults before falling back to the legacy
   * session-routed delivery. The multi-step branch registers
   * `wired.routeInbound` against the deployment's mail address once
   * `supervisor.spawn` succeeds so inbound mail aimed at the
   * deployment address flows into the supervisor's mail-bus
   * subscription.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end mail loop can omit the binding; an absent registry
   * simply means multi-step inbound mail cannot route through the
   * hub-link until the wiring is plumbed.
   */
  multistepMailRouter?: MultistepMailRouter;
  /**
   * Per-deployment-address signal handler registry the sidecar
   * hub-link's `signal.deliver` path consults. The multi-step branch
   * registers `wired.supervisor.deliverSignal` against the deployment's
   * mail address once `supervisor.spawn` succeeds so a hub-side
   * `signal.deliver` frame flows into the workflow-process child via
   * the IPC's `signal.deliver` payload. The child commits the
   * resulting `SignalReceived` event through its own substrate,
   * preserving the workflow-run repo's single-writer invariant on the
   * sidecar side.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end signal loop can omit the binding; an absent registry
   * means hub-side signals cannot route through the hub-link until the
   * wiring is plumbed.
   */
  multistepSignalRouter?: MultistepSignalRouter;
  /**
   * Per-deployment-address drain handler registry the sidecar
   * hub-link's `drain.deliver` path consults. The multi-step branch
   * registers `wired.supervisor.drain` against the deployment's mail
   * address once `supervisor.spawn` succeeds so a hub-side
   * `drain.deliver` frame flows into the workflow-process child via
   * the IPC's `drain` payload and arms the supervisor's per-run
   * `drainTimeout` accumulators. Cancel-mode in-flight steps abort on
   * the child side; wait-mode steps continue. Accumulators commit a
   * signed `CancelRequested{origin: "supervisor-drain"}` against the
   * workflow-run repo when the deadline expires.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end drain loop can omit the binding; an absent registry
   * means hub-side drain frames cannot route through the hub-link until
   * the wiring is plumbed.
   */
  multistepDrainRouter?: MultistepDrainRouter;
  /**
   * Per-deployment-address grants handler registry the sidecar
   * hub-link's `run.grants` path consults. Both deploy branches
   * register a handler against the deployment's mail address once
   * `supervisor.spawn` succeeds so a hub-side `run.grants` frame writes
   * the run's grants to `runs/<runId>/grants.json` in the deployment's
   * workflow-run repo -- durable next to the run's events, and shipped
   * to the hub with the repo's pack flow.
   *
   * Optional so tests that exercise deploys without a grants loop can
   * omit the binding; an absent registry means inbound `run.grants`
   * frames cannot route through the hub-link until the wiring is
   * plumbed.
   */
  multistepGrantsRouter?: MultistepGrantsRouter;
  /**
   * Per-deployment-address sources-rotation handler registry. Only a
   * single-step warm deployment registers a handler (against the
   * deployment's mail address once `supervisor.spawn` succeeds) so a
   * rotation resolved for its address flows into
   * `wired.supervisor.deliverSources` and on to the child's warm agent. A
   * multi-step deployment registers none -- it has no single warm agent to
   * rotate -- so `tryRoute` reports its address as unrouted.
   *
   * Optional so tests that exercise deploys without a rotation loop can
   * omit the binding; an absent registry means no rotation handler is
   * installed for any deployment.
   */
  multistepSourcesRouter?: MultistepSourcesRouter;
  /**
   * Per-deployment-address credential-delivery handler registry the sidecar
   * hub-link's `credentials.update` path consults. Registered for EVERY
   * deployment (not only warm single-step ones) once `supervisor.spawn`
   * succeeds -- the material cell is per-child and read by every step's
   * tool capabilities -- so a hub-side `credentials.update` frame dispatches
   * through the supervisor's `deliverCredentials`, refreshing the child's
   * material cell without ever persisting the secret to disk.
   *
   * Optional so tests that exercise deploys without a credential-rotation
   * loop can omit the binding; an absent registry means an inbound
   * `credentials.update` frame is unrouted for every deployment.
   */
  multistepCredentialsRouter?: MultistepCredentialsRouter;
  /**
   * Optional per-message dispatch-timing observer the multi-step branch
   * forwards to each supervisor it constructs. Resolved at the sidecar
   * boot edge from a benchmark env gate; absent in ordinary
   * production. The supervisor runs in this sidecar subprocess,
   * so the observer sees both ends of the per-message IPC round-trip in
   * one process and can emit a parseable timing line the benchmark
   * harness reads off the subprocess's output stream.
   */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /**
   * forced-repack A/B toggle the multi-step branch forwards to
   * each supervisor it constructs. Resolved at the sidecar boot edge from
   * the same benchmark env gate; absent in ordinary production.
   */
  repackEveryMessages?: { everyMessages: number };
  /**
   * Consumed-dedup retention horizon (ms) forwarded to every supervisor
   * the router constructs. The sidecar boot edge resolves the operator's
   * `CONSUMED_RETENTION_MS` config; absent, the supervisor applies
   * `DEFAULT_CONSUMED_RETENTION_MS` (24h). See the workflow-run kind
   * handler for the operator-owned horizon invariant.
   */
  consumedRetentionMs?: number;
  /**
   * Spawn ready-handshake timeout (ms) forwarded to every supervisor the
   * router constructs. The sidecar boot edge resolves the operator's
   * `CHILD_READY_TIMEOUT_MS` config; absent, the supervisor applies
   * `DEFAULT_READY_TIMEOUT_MS` (30s). A child that spawns but never
   * signals ready is killed and its spawn rejected rather than hanging
   * the deploy or boot-time restore.
   */
  readyTimeoutMs?: number;
  /**
   * Deployment-record writer, injectable so a test can block or fail the
   * persist at a controlled point -- the natural seam for exercising a
   * recycle that interleaves the source-rotation persist window. Defaults
   * to the real `writeWorkflowDeploymentRecord`; production never overrides
   * it.
   */
  writeWorkflowDeploymentRecord?: typeof writeWorkflowDeploymentRecord;
  /**
   * CL-5477 idle-reap threshold (ms): how long a deployment's
   * workflow-child may sit with no activity (inbound mail, signals,
   * drains, source rotations, credential updates, inference events)
   * before the router parks it -- tears the child process down while
   * keeping the persisted deployment record, slug claim, and step state,
   * so the next inbound frame respawns it via `ensureAwake`. `undefined`
   * or `0` disables reaping entirely (no sweep timer is armed, and boot
   * restore never restores-as-parked).
   */
  idleReapMs?: number;
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
    ((
      _address: string,
      _event: InferenceEvent,
      _sessionId: string | undefined,
    ): void => {
      /* no-op default: tests and production-without-a-publisher
         deployments do not consume events. */
    });
  const multistepSubstrateEnv = deps.multistepSubstrateEnv ?? {};
  // Sidecar data dir the deployment's per-step scratch is rooted under
  // (`<dataDir>/workflow-step-state/<deploymentId>/...`). Resolved once
  // from the boot-edge substrate env so the undeploy hook can reclaim
  // the whole subtree. Absent only when the router is wired without
  // substrate config (a test that never spawns a child), in which case
  // no child ever rooted scratch and the undeploy reclaim is correctly
  // skipped.
  const stepStateDataDir = multistepSubstrateEnv.SIDECAR_DATA_DIR;
  const persistDeploymentRecord =
    deps.writeWorkflowDeploymentRecord ?? writeWorkflowDeploymentRecord;
  const multistepSpawner =
    deps.multistepSubprocessSpawner ?? defaultSubprocessSpawner;
  const multistepDeriveStepAddress: DeriveStepAddress =
    deps.multistepDeriveStepAddress ??
    (({ runId, stepId }) => `${runId}-${stepId}`);

  // Per-deployment supervisor tracking. The multi-step branch
  // constructs one `SidecarWorkflowSupervisor` per `agent.deploy`
  // frame; the supervisor owns the workflow-process child, its IPC
  // pipes, and its event-channel fd. The undeploy hook consults this
  // map to call `supervisor.shutdown()` so the child's lifetime ends
  // with the deployment.
  const activeSupervisors = new Map<string, SidecarWorkflowSupervisor>();

  // =============================================================
  // CL-5477 idle reap: park / wake / sweep state
  // =============================================================

  /**
   * Addresses this router has parked: idle-torn-down but still holding
   * their slug, deployment record, and step-state scratch. Value is the
   * address's deployment id, cached so a wake or undeploy does not
   * re-derive it. `activeAddresses()` unions this with `activeSupervisors`
   * so the hub keeps routing a parked address's mail here.
   */
  const parkedAddresses = new Map<string, string>();
  /** Last observed activity per LIVE address, consulted by `sweepIdleDeployments`. */
  const lastActivityAt = new Map<string, number>();
  /**
   * Open run ids per address. A run with an entry here is never parked,
   * even past the idle threshold: a run quietly awaiting a slow tool call
   * or timer emits neither frames nor inference events, and killing its
   * child would strand the run until the next inbound frame happens to
   * wake it. Populated/cleared by the caller's run-lifecycle wiring; this
   * router only reads it.
   */
  const openRuns = new Map<string, Set<string>>();
  /** In-flight wakes, single-flighted per address (see `ensureAwake`). */
  const wakeInFlight = new Map<string, Promise<void>>();
  /** In-flight parks per address (see `parkDeployment`). */
  const parksInFlight = new Map<string, Promise<void>>();
  /** Wall-clock of the last durable activity-marker write per address, for the write throttle in `touchActivity`. */
  const lastActivityMarkerWriteAt = new Map<string, number>();
  /** Flipped true during `shutdownAll`; `ensureAwake` refuses to respawn once set. */
  let routerShuttingDown = false;
  let idleSweepTimer: ReturnType<typeof setInterval> | undefined;

  // Synchronous single-flight guard for the deploy path. The real supervisor
  // does not exist until inside `spawnWorkflowDeployment`, so `deployMultiStep`
  // cannot reserve its `activeSupervisors` slot up front; instead it records
  // the address here synchronously, before its first await, and clears it in a
  // finally once the deploy settles. `activeSupervisors` is populated only
  // after `spawn` succeeds, so the has-check alone leaves a window in which two
  // same-address frames both pass and the loser's unwind deletes the winner's
  // live deployment record. This set closes that window: a second frame that
  // arrives while the first is mid-deploy is rejected before it touches any
  // durable state. Only the live deploy path reserves; the boot restore path
  // is serial and relies on the `activeSupervisors` backstop instead.
  const reservingDeployAddresses = new Set<string>();

  // Slug-collision tracking. `deriveDeploymentId` substitutes
  // disallowed characters with `-`, which is deterministic but lossy:
  // two distinct agent addresses can collapse to the same slug, and
  // a collision would let the second deploy silently overwrite the
  // first deploy's workflow-run repo state (the slug IS the repoId).
  // This map records the first-claimer; a subsequent deploy that
  // produces the same slug from a different address is rejected at
  // the router before any supervisor or repo state is touched.
  const slugClaims = new Map<string, string>();

  function claimSlug(deploymentId: string, agentAddress: string): void {
    const existing = slugClaims.get(deploymentId);
    if (existing !== undefined && existing !== agentAddress) {
      throw new Error(
        `deriveDeploymentId collision: agent addresses ${JSON.stringify(existing)} and ${JSON.stringify(agentAddress)} both project to deploymentId ${JSON.stringify(deploymentId)}`,
      );
    }
    // A same-address re-claim is a defensive no-op: the `activeSupervisors`
    // guard rejects a live re-deploy before claimSlug is re-invoked, and a
    // failed or undeployed deploy releases the slug first, so in practice
    // `existing` is only ever undefined or a different address here.
    slugClaims.set(deploymentId, agentAddress);
  }

  function releaseSlug(deploymentId: string, agentAddress: string): void {
    const existing = slugClaims.get(deploymentId);
    if (existing === agentAddress) slugClaims.delete(deploymentId);
  }

  /**
   * Record that `agentAddress` just did something -- inbound mail, a
   * signal, a drain, a source rotation, a credential update, or an
   * inference event. Called from every one of those dispatch points on the
   * LIVE handler path (not the parked/wake path, where activity is a
   * contradiction) so `sweepIdleDeployments` never reaps a deployment
   * mid-conversation, including one quietly running a long tool call
   * between events.
   *
   * Updates the in-process `lastActivityAt` map unconditionally, then
   * throttles a durable marker write (`writeWorkflowDeploymentActivityMarker`)
   * to roughly a quarter of the idle-reap window -- the same cadence the
   * sweep itself runs at -- so a boot restore's staleness check
   * (`readWorkflowDeploymentActivityMs`) is never more than one sweep
   * period behind the truth, without writing a file on every single
   * message. Skipped entirely when reaping is disabled or no data dir is
   * wired (a test router that never persists).
   */
  function touchActivity(agentAddress: string): void {
    const now = Date.now();
    lastActivityAt.set(agentAddress, now);
    if (
      deps.idleReapMs === undefined ||
      deps.idleReapMs <= 0 ||
      stepStateDataDir === undefined
    ) {
      return;
    }
    const throttleMs = Math.min(60_000, Math.max(1_000, deps.idleReapMs / 4));
    const lastWrite = lastActivityMarkerWriteAt.get(agentAddress) ?? 0;
    if (now - lastWrite < throttleMs) return;
    lastActivityMarkerWriteAt.set(agentAddress, now);
    const deploymentId = deriveDeploymentId(agentAddress);
    void writeWorkflowDeploymentActivityMarker(
      stepStateDataDir,
      deploymentId,
      now,
    ).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn`touchActivity: failed to persist activity marker for ${agentAddress}: ${reason}`;
    });
  }

  /**
   * The per-deployment inputs the shared spawn core needs to stand up a
   * workflow deployment, independent of the live deploy frame. The live
   * deploy path builds this from `frame`/`projection`; a boot-time restore
   * path builds the same shape from the persisted deployment record.
   */
  interface WorkflowDeploySpec {
    agentAddress: string;
    definition: NonNullable<AgentDeployFrame["workflow"]>["definition"];
    sources: NonNullable<AgentDeployFrame["workflow"]>["sources"];
    /** Correlates the child's inference events to the deploy's session. */
    sessionId: string | undefined;
    /**
     * Hub public key recorded at the head for deploy-pack verification and
     * inbound hub-frame verification. Required for a single-step
     * deployment (whose head IS the agent identity); undefined for a
     * genuine multi-step deployment, which derives per-step addresses and
     * records no head key.
     */
    hubPublicKey: string | undefined;
    /**
     * Hub-approved wire hash per referenced onTrigger body id, sourced from
     * the deploy frame's `referencedDefinitions[*].approvedWireHash`. Threaded
     * to the spawned child as `REFERENCED_DEFINITION_HASHES` so a body spawn
     * can re-verify against the parent's approval
     * (`WorkflowSpawnSuspendableChildOpts.referencedDefinitionHashes`).
     * Undefined for a deployment with no referenced bodies.
     */
    referencedDefinitionHashes: Record<string, string> | undefined;
    /**
     * Decrypted credential material from the deploy frame's
     * `workflow.credentials`, threaded to the supervisor's
     * `credentialDelivery` binding so the child's materialRef is seeded
     * before the first trigger. Frame-only and never persisted (secrets
     * stay off disk), so the boot-restore path rebuilds the spec without
     * it and the deployment waits for the hub's `credentials.update` push.
     */
    credentials: NonNullable<AgentDeployFrame["workflow"]>["credentials"];
  }

  /**
   * Build the durable deployment record from a spec and a source table. The
   * table is a parameter (not `spec.sources`) so the deploy path writes the
   * deploy-time sources while the rotation handler writes the live-rotated
   * ones -- both through one shape, so a rotation persists the same record a
   * boot-time restore reseeds from.
   */
  function buildDeploymentRecord(
    spec: WorkflowDeploySpec,
    sources: WorkflowDeploymentRecord["sources"],
  ): WorkflowDeploymentRecord {
    const recordBase = {
      version: 1 as const,
      agentAddress: spec.agentAddress,
      definitionId: spec.definition.id,
      sources,
    };
    const recordWithSessionId =
      spec.sessionId !== undefined
        ? { ...recordBase, sessionId: spec.sessionId }
        : recordBase;
    const recordWithHubPublicKey =
      spec.hubPublicKey !== undefined
        ? { ...recordWithSessionId, hubPublicKey: spec.hubPublicKey }
        : recordWithSessionId;
    return spec.referencedDefinitionHashes !== undefined
      ? {
          ...recordWithHubPublicKey,
          referencedDefinitionHashes: spec.referencedDefinitionHashes,
        }
      : recordWithHubPublicKey;
  }

  /**
   * Derive the `bodyId -> approvedWireHash` map the spawn core threads to the
   * child from the deploy frame's `referencedDefinitions`. Only a body whose
   * entry actually carries `approvedWireHash` contributes -- the wire schema
   * makes it optional for a frame built before the source-ref hand-off, and
   * an unhashed body is exactly the misconfigured-deploy case the spawn-child
   * adapter's `resolveVerifiedBody` fails closed on, so this must not paper
   * over a missing hash with a fabricated one. Returns `undefined` for a
   * deployment with no referenced bodies at all, matching the field's
   * optional-when-absent shape on both the spec and the durable record.
   */
  function deriveReferencedDefinitionHashes(
    referencedDefinitions: NonNullable<
      AgentDeployFrame["workflow"]
    >["referencedDefinitions"],
  ): Record<string, string> | undefined {
    if (
      referencedDefinitions === undefined ||
      referencedDefinitions.length === 0
    ) {
      return undefined;
    }
    const hashes: Record<string, string> = {};
    for (const referenced of referencedDefinitions) {
      if (referenced.approvedWireHash !== undefined) {
        hashes[referenced.definition.id] = referenced.approvedWireHash;
      }
    }
    return hashes;
  }

  /**
   * Wrap the substrate RepoStore so this deployment's proxied workflow-run
   * writes maintain `openRunIds` -- the CL-5477 idle sweep's "never park a
   * deployment with an open run" guard. Only `writeTreePreservingPrefix`
   * against THIS deployment's workflow-run repo is intercepted -- the
   * supervisor routes every child run-event commit through it, and its
   * result carries the kind handler's authoritative terminal-run signal.
   * Everything else delegates untouched.
   */
  function createRunTrackingRepoStore(
    underlying: RepoStore,
    deploymentId: string,
    openRunIds: Set<string>,
    onTrackedWrite: () => void,
  ): RepoStore {
    // Boundary type assertion: a transparent delegation proxy over the
    // full RepoStore surface, matching the rest of this file's Proxy casts.
    return new Proxy(underlying, {
      get(target, prop, receiver) {
        if (prop !== "writeTreePreservingPrefix") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        const write: RepoStore["writeTreePreservingPrefix"] = async (
          principal,
          repoId,
          ref,
          args,
        ) => {
          const tracked =
            repoId.kind === "workflow-run" && repoId.id === deploymentId;
          if (tracked) {
            const match = /^runs\/([^/]+)\/events\//.exec(args.preservePrefix);
            if (match?.[1] !== undefined) openRunIds.add(match[1]);
            // Run-event commits also bump the durable activity marker
            // (through the throttle in `touchActivity`), so a deployment
            // mid-run keeps a fresh marker even when its inference events
            // are sparse -- the boot-time restore-vs-park decision must
            // never judge a running deployment stale.
            onTrackedWrite();
          }
          const result = await target.writeTreePreservingPrefix(
            principal,
            repoId,
            ref,
            args,
          );
          if (tracked) {
            for (const terminal of result.newlyTerminalRuns) {
              openRunIds.delete(terminal.runId);
            }
          }
          return result;
        };
        return write;
      },
    }) as RepoStore;
  }

  /**
   * The single owner of the workflow-deployment spawn sequence: construct
   * the supervisor, register the single-step agent's outbound key + head
   * repo + hub key, spawn the workflow-process child, then register the
   * live deployment (supervisor, mail/signal/drain routers, address
   * mapping). Its `try/finally` unwinds every piece of partial state if any
   * step throws, so a failed spawn leaks nothing. Both the live deploy path
   * and the boot-time restore path route through here so the two can never
   * diverge on how a deployment is stood up. Callers materialize the
   * deploy-only durable state (`workflow.json`, step grants) before calling.
   */
  async function spawnWorkflowDeployment(
    spec: WorkflowDeploySpec,
  ): Promise<DeployRouterResult> {
    // Fail loud if this address already has a live supervisor. Both single-
    // and multi-step now register on the transport, so both carry the
    // `transport.register` duplicate-throw backstop; this `has()` check is the
    // primary early guard that gives a clean error before that lower-level
    // throw and before the `activeSupervisors.set` below could clobber the
    // running deployment's handle. Both the deploy path and the boot restore
    // path route through here, so this is the single transition guard against
    // a double-spawn -- notably a boot restore racing a legacy restore for the
    // same address.
    if (activeSupervisors.has(spec.agentAddress)) {
      throw new Error(
        `sidecar deploy router: a supervisor is already active for ${spec.agentAddress}; refusing to spawn a second`,
      );
    }
    const deploymentId = deriveDeploymentId(spec.agentAddress);

    // Single-step launched-agent deploy vs. derived multi-step deploy. A
    // one-step deployment keeps the deployment's own (legacy) mail address
    // and its grants in the legacy agent-state repo keyed by the legacy
    // instance id. A multi-step deployment derives `<deploymentId>-<stepId>`
    // per step for both the mail address and the agent-state repo id.
    const stepStrategy = createStepStrategy({
      legacyAddress: spec.agentAddress,
      stepOrder: spec.definition.stepOrder,
      multistepDeriveStepAddress,
    });

    // Unwind every piece of spawn state if any step in this block throws,
    // so a failed spawn leaks no freshly-spawned workflow-process child,
    // `activeSupervisors` entry, transport registration, or multistep
    // router registration. (The deployment-address registration happens
    // before spawn and is unwound by its own guard.) The ordering inside
    // the finally is the reverse of the success-path registration order.
    // The caller owns the deployment slug: it must
    // claim the collision guard before any durable write and release it on
    // failure, so the slug is not touched here.
    let succeeded = false;
    let wiredForUnwind: SidecarWorkflowSupervisor | undefined;
    let supervisorRegistered = false;
    let routersRegistered = false;
    let agentTransportRegistered = false;
    let hubKeyRecorded = false;
    let deploymentRegistered = false;
    try {
      const definitionHash = await computeWireDefinitionHash(spec.definition);

      // Warm-keep is the single-step launched-agent deploy: the sole step
      // IS the long-lived agent, so the child warm-keeps it across
      // messages. A multi-step deploy keeps instantiate-send-teardown per
      // step. Computed early because both the recycle-policy wiring below
      // and the spawn opts further down key off it.
      const warmKeep = spec.definition.stepOrder.length === 1;

      // Per-deployment substrate-config keys the workflow-substrate-factory
      // validator requires. The boot edge's `multistepSubstrateEnv` carries
      // the boot-edge constants; the four workflow-definition / workflow-run
      // identity keys are derived per-deploy here.
      const substrateEnv: Record<string, string> = {
        ...multistepSubstrateEnv,
        WORKFLOW_DEFINITION_REPO_ID: spec.definition.id,
        WORKFLOW_DEFINITION_REF: "refs/heads/main",
        WORKFLOW_RUN_REPO_ID: deploymentId,
        WORKFLOW_RUN_REF: "refs/heads/main",
        // Frozen for the deployment's lifetime, matching STEP_INFERENCE_SOURCES'
        // sibling constants above -- unlike sources, a referenced body's
        // approved hash never rotates independently of a redeploy. The
        // workflow-host child parser (`parseSpawnTimeEnv`) treats an absent key
        // as "no referenced bodies"; serializing `{}` here is equivalent and
        // keeps this producer unconditional like its neighbors.
        REFERENCED_DEFINITION_HASHES: JSON.stringify(
          spec.referencedDefinitionHashes ?? {},
        ),
      };
      // Live-rotatable per-step inference sources. Seeded from the deploy
      // spec, then revised in place by the single-step sources-rotation
      // handler below. `STEP_INFERENCE_SOURCES` is NOT in the frozen
      // `substrateEnv`: it is recomputed on every spawn and recycle respawn
      // via `dynamicSpawnEnv`, so a rotation survives a recycle instead of
      // reverting to the deploy-time list.
      let currentSources = spec.sources;

      // In-flight-run tracking for the idle sweep (CL-5477). Created per
      // spawn and installed under the address only once spawn succeeds; the
      // supervisor's proxied child writes flow through the wrap from the
      // first commit.
      const openRunIds = new Set<string>();

      const wiredBaseConfig = {
        transport: deps.transport,
        repoStore: createRunTrackingRepoStore(
          deps.repoStore,
          deploymentId,
          openRunIds,
          () => {
            touchActivity(spec.agentAddress);
          },
        ),
        signingKeySeed: deps.signingKeySeed,
        workflowRunRepoId: {
          kind: "workflow-run" as const,
          id: deploymentId,
        },
        workflowRunRef: "refs/heads/main",
        deploymentId,
        stepCount: spec.definition.stepOrder.length,
        stepOrder: spec.definition.stepOrder,
        warmKeep,
        deploymentMailAddress: spec.agentAddress,
        deriveStepAddress: stepStrategy.deriveStepAddress,
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        substrateEnv,
        // Recomputed on every spawn AND recycle respawn. The rotation
        // handler below revises `currentSources` in place, so a respawn
        // re-serializes the current (possibly rotated) list rather than the
        // frozen deploy-time value.
        dynamicSpawnEnv: () => ({
          [STEP_INFERENCE_SOURCES_ENV_KEY]: JSON.stringify(currentSources),
        }),
        subprocessSpawner: multistepSpawner,
      };
      const wiredConfigWithOnSuspensionRegister =
        deps.registerSuspension !== undefined
          ? {
              ...wiredBaseConfig,
              onSuspensionRegister: deps.registerSuspension,
            }
          : wiredBaseConfig;
      const wiredConfigWithCredentialDelivery =
        spec.credentials !== undefined
          ? {
              ...wiredConfigWithOnSuspensionRegister,
              credentialDelivery: spec.credentials,
            }
          : wiredConfigWithOnSuspensionRegister;
      const wiredConfigWithBinaryPath =
        deps.multistepBinaryPath !== undefined
          ? {
              ...wiredConfigWithCredentialDelivery,
              binaryPath: deps.multistepBinaryPath,
            }
          : wiredConfigWithCredentialDelivery;
      const wiredConfigWithOnDispatchTiming =
        deps.onDispatchTiming !== undefined
          ? {
              ...wiredConfigWithBinaryPath,
              onDispatchTiming: deps.onDispatchTiming,
            }
          : wiredConfigWithBinaryPath;
      const wiredConfigWithRepackEveryMessages =
        deps.repackEveryMessages !== undefined
          ? {
              ...wiredConfigWithOnDispatchTiming,
              repackEveryMessages: deps.repackEveryMessages,
            }
          : wiredConfigWithOnDispatchTiming;
      const wiredConfigWithConsumedRetentionMs =
        deps.consumedRetentionMs !== undefined
          ? {
              ...wiredConfigWithRepackEveryMessages,
              consumedRetentionMs: deps.consumedRetentionMs,
            }
          : wiredConfigWithRepackEveryMessages;
      const wiredConfig =
        deps.readyTimeoutMs !== undefined
          ? {
              ...wiredConfigWithConsumedRetentionMs,
              readyTimeoutMs: deps.readyTimeoutMs,
            }
          : wiredConfigWithConsumedRetentionMs;
      const wired = createSidecarWorkflowSupervisor(wiredConfig);

      // OUTBOUND half of mailbox ownership: register a signing key for
      // the deployment mail address on the host transport so the supervisor
      // signs the deployment's outbound mail. Every step -- single- or
      // multi-step -- signs its outbound sends as `spec.agentAddress` (the
      // one deployment mail address; no per-step sender reaches the host
      // transport), so the transport MUST hold a `CryptoProvider` for it or
      // `getTransportFor(senderAddress).send` throws "not registered".
      // Registration happens before `spawn()` so the address is live the
      // instant the first reply routes outbound.
      const { keyPair } = await deps.keyStore.loadOrGenerateKey(
        spec.agentAddress,
      );
      deps.transport.register(
        spec.agentAddress,
        deps.createAgentCrypto(keyPair),
      );
      agentTransportRegistered = true;

      // The public key the deploy ack surfaces to the hub is the deployment
      // address's own Ed25519 key -- the one `loadOrGenerateKey` minted above,
      // which `AgentKeyStore.signChallenge(spec.agentAddress)` also signs
      // reconnect challenges with. EVERY deployment acks it, single- and
      // multi-step alike, so the hub can verify the reconnect ownership
      // challenge for both: a single-step head records it into
      // `agent_instance.publicKey`; a workflow-derived deployment records it on
      // its `workflow_deployment` row. A multi-step deployment previously acked
      // the supervisor principal key -- which the hub discarded and which does
      // NOT match what `signChallenge` signs with -- so its address could be
      // re-claimed on reconnect without proof; carrying the deployment key
      // closes that.
      const deploymentPublicKey = hexEncode(keyPair.publicKey);
      if (spec.definition.stepOrder.length === 1) {
        // A single-step workflow stages its deploy tree at the head (the
        // lone step IS the head). Initialize the head's on-disk deploy-tree
        // repo (idempotent) so the hub's deploy-pack push has a repo to
        // apply into. The narrow `initRepo` (not `provisionAgent`) is
        // deliberate: the supervised child mints its own keypair and
        // persists no hub-agent config.
        await deps.sessions.initRepo(spec.agentAddress);

        // Record the hub's public key at the head so the deploy-pack apply
        // (and any inbound hub-signed frame) verifies against it. The
        // verifier resolves the key from the in-memory key store's
        // `recordHubKey` map, so a single-step deployment cannot stand up
        // without it.
        if (spec.hubPublicKey === undefined) {
          throw new Error(
            "sidecar deploy router: a single-step workflow deployment requires a hubPublicKey to record at the head; none was supplied",
          );
        }
        deps.keyStore.recordHubKey(spec.agentAddress, spec.hubPublicKey);
        hubKeyRecorded = true;
      }

      const stepOrder = [...spec.definition.stepOrder];
      const spawnOpts: SpawnOpts = {
        stepOrder,
        definitionHash,
        warmKeep,
        onInferenceEvent: (event) => {
          // The event arrives HMAC-verified over the child's event channel.
          // Re-narrow it to the hub's `InferenceEvent` union; a parse
          // failure means upstream corruption, so drop it loudly rather
          // than forwarding an unvalidated payload onto the hub timeline.
          const validated = parseInferenceEvent(event);
          if (validated instanceof type.errors) {
            logger.warn`dropping workflow inference event for ${spec.agentAddress}: ${validated.summary}`;
            return;
          }
          // A silent mid-turn tool call produces no mail/signal/drain
          // traffic, so the inference event stream is the only activity
          // signal for a long-running step; without this, the sweep could
          // park a deployment out from under an in-flight turn.
          touchActivity(spec.agentAddress);
          publishInferenceEvent(spec.agentAddress, validated, spec.sessionId);
        },
      };

      // Record the deployment-address mapping BEFORE `spawn`, because
      // `spawn` kicks off `replayProcessingToInbox`, whose workflow-run
      // substrate write routes through the boot-edge pack-pushing facade and
      // resolves this mapping to address the outbound pack frame. Recording
      // it after `spawn` (as the other registrations below are) loses the
      // race: the replay's write throws "no agent address registered" (a
      // real defect masked as a swallowed best-effort warning in the
      // supervisor's replay catch). Constraint ownership: the registry owns
      // "address is resolvable"; the spawn path must satisfy that contract
      // before the replay writes. The finally unwinds it on any failure
      // between here and the end of the try.
      deps.registerDeployment({
        deploymentId,
        agentAddress: spec.agentAddress,
      });
      deploymentRegistered = true;

      // Surface spawn-time errors structurally: a subprocess spawner that
      // crashes immediately rejects here, and the caller converts the
      // rejection into a structured failure frame. The supervisor is
      // registered against the deployment address only after spawn succeeds,
      // so a spawn-time rejection leaves the registry untouched.
      await wired.supervisor.spawn(spawnOpts);
      wiredForUnwind = wired;
      activeSupervisors.set(spec.agentAddress, wired);
      openRuns.set(spec.agentAddress, openRunIds);
      supervisorRegistered = true;

      // Bind the deployment's mail address to this supervisor's
      // `routeInbound` so the hub-link dispatches inbound mail into the
      // supervisor's mail-bus subscription. Registration happens after
      // `spawn` succeeds so a spawn-time rejection leaves the registry
      // untouched.
      deps.multistepMailRouter?.register(spec.agentAddress, (message) => {
        touchActivity(spec.agentAddress);
        return wired.routeInbound(message);
      });
      // Register the signal-delivery handler so a hub `signal.deliver` frame
      // dispatches through the supervisor's `deliverSignal`.
      deps.multistepSignalRouter?.register(spec.agentAddress, async (args) => {
        touchActivity(spec.agentAddress);
        await wired.supervisor.deliverSignal({
          runId: args.runId,
          signalName: args.signalName,
          signalId: args.signalId,
          payload: args.payload,
        });
      });
      // Register the drain handler so a hub `drain.deliver` frame dispatches
      // through the supervisor's `drain`.
      deps.multistepDrainRouter?.register(spec.agentAddress, async (args) => {
        touchActivity(spec.agentAddress);
        await wired.supervisor.drain({ deadlineMs: args.deadlineMs });
      });
      // Register the grants handler so a hub `run.grants` frame writes the
      // run's grants to `runs/<runId>/grants.json` in the deployment's
      // workflow-run repo. The `runId` selects the per-run destination; the
      // step-fan-out fields are inert in that mode but the shared write
      // machinery still takes them. A write failure re-throws so the
      // hub-link logs the durable-write failure loudly.
      deps.multistepGrantsRouter?.register(spec.agentAddress, async (args) => {
        await writeStepGrants({
          repoStore: deps.repoStore,
          deploymentId,
          stepOrder: spec.definition.stepOrder,
          deriveStepRepoId: stepStrategy.deriveStepRepoId,
          grants: args.stepGrants,
          runId: args.runId,
        });
      });
      // Register the sources-rotation handler ONLY for a single-step warm
      // deployment: it has one long-lived agent whose sources can be
      // swapped in place. A multi-step deployment has no single warm agent,
      // so it registers no handler and `tryRoute` reports its address as
      // unrouted.
      if (warmKeep) {
        // A single-step deployment's source table has exactly one entry,
        // keyed by the head step. Derive that key once here (the layer that
        // owns the single-key invariant); `deliverSources` stays flat and
        // stepId-agnostic.
        const rotationStepId = spec.definition.stepOrder[0];
        if (rotationStepId === undefined) {
          throw new Error(
            "single-step deploy has no step id for sources rotation",
          );
        }
        deps.multistepSourcesRouter?.register(
          spec.agentAddress,
          async (args) => {
            touchActivity(spec.agentAddress);
            const rotated = { [rotationStepId]: args.sources };
            // Swap `currentSources` synchronously BEFORE the durable persist.
            // `currentSources` is the process-local respawn hint the
            // supervisor reads synchronously through `dynamicSpawnEnv`, so a
            // recycle that interleaves the persist `await` must respawn the
            // child on the SAME sources being persisted, not the stale prior
            // table. The obvious inverse -- persist first, then swap -- is
            // rejected: it leaves the child on the OLD sources during the
            // persist window while the record has already moved to NEW, so a
            // recycle there respawns stale and a restart would "correct" it,
            // i.e. the running child contradicts durable intent. Swapping
            // first makes the only residual disagreement child-ahead-of-
            // durable on a failed persist, which the next recycle heals down
            // to the rolled-back durable truth -- the benign direction. The
            // wire boundary guarantees `args.sources[0]` is the default,
            // which the recycle env form pins as the active source.
            const prevSources = currentSources;
            currentSources = rotated;
            // The durable write still precedes the LIVE swap
            // (`deliverSources`), preserving persist-before-externally-visible
            // for state that outlives the process; only the process-local
            // respawn hint moves ahead. On a failed persist, roll the hint
            // back so `currentSources` and the record stay in agreement in the
            // common (no interleaved recycle) failure case -- the invariant
            // restart consistency depends on. Persistence lets the rotation
            // survive a full sidecar restart, not just a recycle: the boot
            // scan reseeds spec.sources from record.sources. Overwrites the
            // deploy-time record in place. Skipped when no data dir was wired
            // (a test router that never persists), matching the restore guard.
            if (stepStateDataDir !== undefined) {
              try {
                await persistDeploymentRecord(
                  stepStateDataDir,
                  deploymentId,
                  buildDeploymentRecord(spec, rotated),
                );
              } catch (cause) {
                // Restoring unconditionally is safe because rotations for one
                // deployment are serialized by the sidecar's per-connection
                // inbound-frame queue: each hub frame, sources.update
                // included, runs its handler to completion on that queue
                // before the next frame's handler starts, so no second
                // rotation is in flight whose committed table this rollback
                // could clobber. This does NOT rely on the hub pacing its
                // sends -- the hub dispatches sources.update fire-and-forget;
                // the sidecar frame queue is the sole serializer. Parallelizing
                // inbound-frame dispatch would break this rollback.
                currentSources = prevSources;
                throw cause;
              }
            }
            await wired.supervisor.deliverSources({
              sources: args.sources,
              defaultSource: args.defaultSource,
            });
          },
        );
      }

      // Register the credential-delivery handler for EVERY deployment (not
      // only warm single-step ones): the material cell is per-child and read
      // by every step's tool capabilities. The handler hands the delivery to
      // the supervisor's `deliverCredentials`, which sends a
      // `credentials-updated` control frame to the child where the material
      // cell is swapped. No durable persist -- credential material never
      // touches disk.
      deps.multistepCredentialsRouter?.register(
        spec.agentAddress,
        async (args) => {
          touchActivity(spec.agentAddress);
          await wired.supervisor.deliverCredentials({
            delivery: args.delivery,
          });
        },
      );
      routersRegistered = true;

      // Seed the child's credential material NOW: this hub does not yet
      // ship the per-run `run.grants` frame upstream's onRunStart barrier
      // consumes (CL-6194 reopened), so without this push the delivered
      // material would sit on the supervisor bindings forever and every
      // `credentials.resolve(handle)` would fail "no credential is bound".
      // Delete this push again only once the hub writes
      // `runs/<runId>/grants.json` on every birth path.
      if (spec.credentials !== undefined) {
        await wired.supervisor.deliverCredentials({
          delivery: spec.credentials,
        });
      }

      // A newly-live deployment starts its idle clock now, whether this is
      // a fresh deploy, a boot-time restore, or a CL-5477 wake respawn. A
      // wake respawn also clears the parked-address bookkeeping the address
      // held while parked -- `ensureAwake`'s wake handlers were already
      // swapped out for the real ones registered just above.
      touchActivity(spec.agentAddress);
      parkedAddresses.delete(spec.agentAddress);
      succeeded = true;
      return { publicKey: deploymentPublicKey };
    } finally {
      if (!succeeded) {
        // Unwind in reverse registration order so each step undoes state
        // the success path confirmed; ordering matches the `undeploy` hook.
        if (routersRegistered) {
          deps.multistepMailRouter?.unregister(spec.agentAddress);
          deps.multistepSignalRouter?.unregister(spec.agentAddress);
          deps.multistepDrainRouter?.unregister(spec.agentAddress);
          deps.multistepGrantsRouter?.unregister(spec.agentAddress);
          // Unregister unconditionally: the sources handler was registered
          // only for a single-step deploy, but `unregister` is a no-op for
          // an address that never registered one, so a multi-step unwind
          // safely calls it too.
          deps.multistepSourcesRouter?.unregister(spec.agentAddress);
          deps.multistepCredentialsRouter?.unregister(spec.agentAddress);
        }
        if (supervisorRegistered) {
          activeSupervisors.delete(spec.agentAddress);
          openRuns.delete(spec.agentAddress);
        }
        if (wiredForUnwind !== undefined) {
          await wiredForUnwind.supervisor.shutdown().catch((cause) => {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            logger.warn`multi-step deploy unwind: supervisor.shutdown failed: ${message}`;
          });
        }
        if (agentTransportRegistered) {
          // Drop the agent's transport registration so a failed deploy does
          // not leave the address live with a dangling `CryptoProvider`.
          deps.transport.unregister(spec.agentAddress);
        }
        if (hubKeyRecorded) {
          // Reverse the single-step head's `recordHubKey` so a failed deploy
          // leaves no in-memory hub key behind. `forgetAgent` also drops the
          // agent keypair cache `loadOrGenerateKey` populated, which is safe:
          // the transport registration is already unwound above, nothing reads
          // that cache after unwind, and a redeploy reloads the keypair from
          // disk. The on-disk deploy-tree repo `initRepo` created is
          // deliberately NOT reversed. It is idempotent and the hub re-pushes
          // the deploy pack on every redeploy, so it is benign residue; and
          // decisively, the durable Ed25519 identity keypair lives inside that
          // same directory (`keys/` nests under the agent repo dir), so
          // removing the repo would destroy an identity a rerouted head must
          // keep across a failed redeploy.
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
            deploymentId,
            agentAddress: spec.agentAddress,
          });
        }
      }
    }
  }

  /**
   * Provision one step of a multi-step deploy WITHOUT spawning. The hub
   * stages each step's deploy tree before firing the deployment-level
   * workflow frame; a full-closure deploy pack still needs an initialized
   * agent-state repo to apply into and the hub key recorded to verify the
   * pack commit signature. This does exactly those two things -- the same
   * harness-free `initRepo` + `recordHubKey` seam the single-step head uses
   * -- and constructs no supervisor or child. The deployment-level workflow
   * frame (fired once after every step is provisioned) spawns the child,
   * which reads each step's staged deploy tree from disk.
   *
   * Returns the sidecar's principal public key so the link's
   * `agent.deploy.ack` carries a key, matching the multi-step ack. A
   * per-step address is workflow-derived and records no `agent_instance`
   * key, so the hub discards this value.
   */
  async function provisionStep(
    frame: AgentDeployFrame,
  ): Promise<DeployRouterResult> {
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
    // Boundary validation: a malformed projection is rejected at the
    // router edge before the supervisor is constructed so the link
    // surfaces a structured failure rather than a hung `starting`
    // supervisor.
    validateWorkflowProjection(projection);

    // Source-admission gate: reject a deploy where any step pins an
    // inference provider this sidecar cannot build, BEFORE any state is
    // claimed or the child is spawned. The throw propagates back through
    // the deploy frame so the hub's `deployWorkflow` rejects synchronously
    // at deploy time, rather than the child failing the run when the
    // step's inference first resolves. Covers single- and multi-step: the
    // projection's `narrow` guarantees every stepOrder entry has a
    // `sources` entry. Every source in a step's failover chain must be
    // buildable -- a chain with an unbuildable tail would fail only after
    // the reactor failed over onto it -- so this iterates the whole list.
    for (const stepId of projection.definition.stepOrder) {
      const chain = projection.sources[stepId];
      if (chain !== undefined) {
        for (const source of chain) deps.assertSourceBuildable(source);
      }
    }

    // Reject a re-deploy of an address already live OR mid-deploy in this
    // process BEFORE touching any durable state. The durable writes below (the
    // restore record, workflow.json, step grants) are destructive overwrites of
    // state owned by whatever deployment currently holds the address;
    // overwriting is only legal when this deploy owns the address.
    // `activeSupervisors` catches an address whose deploy has completed;
    // `reservingDeployAddresses` catches one whose deploy is still in flight.
    // The map is populated only after `spawn` succeeds, so the has-check alone
    // leaves a window in which two frames both pass and the loser's catch below
    // deletes the winner's live record; the reservation set closes it. A
    // re-deploy after `undeploy` passes: `undeploy` drops the
    // `activeSupervisors` entry, and a failed or completed deploy has already
    // cleared its reservation.
    if (
      activeSupervisors.has(frame.agentAddress) ||
      reservingDeployAddresses.has(frame.agentAddress)
    ) {
      throw new Error(
        `sidecar deploy router: ${frame.agentAddress} is already deployed; undeploy it before redeploying`,
      );
    }

    const deploymentId = deriveDeploymentId(frame.agentAddress);

    // Single-step launched-agent deploy vs. derived multi-step deploy.
    //
    // A one-step projection is the agent-launch identity path: the sole
    // step keeps the deployment's own (legacy) mail address, and its
    // grants live in the legacy agent-state repo keyed by the legacy
    // instance id (`parseAgentId(frame.agentAddress)`). This preserves
    // the identity the legacy agent-deploy path established -- the
    // workflow-run repo stays keyed by `deriveWorkflowRunRepoId(legacy)`
    // and `agent_instance.address` remains the `ins_<hex>` legacy shape.
    //
    // A multi-step projection derives `<deploymentId>-<stepId>` per step
    // for both the mail address and the agent-state repo id, isolating
    // each step's grants in its own repo.
    const stepStrategy = createStepStrategy({
      legacyAddress: frame.agentAddress,
      stepOrder: projection.definition.stepOrder,
      multistepDeriveStepAddress,
    });

    // Claim the deployment slug BEFORE any durable write so a colliding
    // deploymentId (two distinct addresses projecting to the same slug) is
    // rejected before `workflow.json`, the step grants, or the supervisor
    // touch disk -- the router's "no repo state touched before rejection"
    // guarantee. The claim is released on any failure below; a successful
    // deploy keeps it (the undeploy hook releases it at teardown). The
    // spawn core owns unwinding the supervisor and registrations it stands
    // up; the slug is the caller's.
    // Resolve the sidecar data dir once: the deployment record, workflow.json,
    // and the per-step scratch all root under it. Required for any deployment
    // that spawns a child.
    const dataDir = stepStateDataDir;
    if (typeof dataDir !== "string" || dataDir.length === 0) {
      throw new Error(
        "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the deployment record and workflow-process child root under it",
      );
    }

    // The spec the shared spawn core consumes, and the durable record that
    // lets a boot-time restore rebuild the SAME spec (definition re-read from
    // workflow.json by id, grants from the step repos, and the record's
    // frame/in-memory-only inputs: sources, session id, single-step hub key,
    // referenced-body hashes).
    const spec: WorkflowDeploySpec = {
      agentAddress: frame.agentAddress,
      definition: projection.definition,
      sources: projection.sources,
      sessionId: frame.config.sessionId,
      hubPublicKey:
        projection.definition.stepOrder.length === 1
          ? frame.hubPublicKey
          : undefined,
      referencedDefinitionHashes: deriveReferencedDefinitionHashes(
        projection.referencedDefinitions,
      ),
      credentials: projection.credentials,
    };
    const record = buildDeploymentRecord(spec, spec.sources);

    claimSlug(deploymentId, frame.agentAddress);
    // Hold the single-flight reservation across the async body below and clear
    // it in the finally. Everything above is synchronous and throws before any
    // durable write, so the reservation is only needed from the first await
    // here onward; the top-of-method guard already consults this set for a
    // concurrent frame, and claimSlug/deploymentId derivation above cannot
    // yield control before this point.
    reservingDeployAddresses.add(frame.agentAddress);
    try {
      // Persist the deployment record BEFORE the spawn so a crash mid-spawn
      // leaves a record the boot scan re-drives (an idempotent re-spawn; the
      // child's in-flight-run discovery resumes any run). A soft-failed deploy
      // deletes it below, so only a crash-interrupted deploy leaves one.
      await persistDeploymentRecord(dataDir, deploymentId, record);

      // Materialize the deploy-only durable state the spawned child and the
      // supervisor read from disk: the workflow definition (`workflow.json`)
      // and each step's grants. The restore path finds both already on disk
      // and skips this; both land before the shared spawn core runs.
      await materializeWorkflowJson(dataDir, projection.definition);

      // Materialize each extracted onTrigger section body as its own
      // `assets/workflow/<bodyRef>/workflow.json` (the body id IS the ref) plus
      // a co-located `sources.json`, so a body child's spawn-child resolves the
      // body definition AND its inference sources off disk without a hub
      // round-trip. The hub also stores each body, but that copy is not on the
      // sidecar; the deploy frame carries them here for exactly this reason. The
      // sources ride on disk (not through env) because the body child is
      // in-process and loses its env across a restart.
      for (const referenced of projection.referencedDefinitions ?? []) {
        await materializeWorkflowJson(dataDir, referenced.definition);
        await materializeWorkflowSources(
          dataDir,
          referenced.definition.id,
          referenced.sources,
        );
      }

      // Grants bridge: the spawned child does not see the frame; it reads
      // each step's grants out of `state/grants.json` in the step's
      // agent-state repo while the supervisor assembles the
      // credentialsSnapshot. Write the operator-approved
      // `frame.config.grants` to the same repo the supervisor reads via
      // `deriveStepRepoId`, before the spawn core, so the read sees them.
      await writeStepGrants({
        repoStore: deps.repoStore,
        deploymentId,
        stepOrder: projection.definition.stepOrder,
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        grants: frame.config.grants,
      });

      // Hand off to the shared spawn core.
      return await spawnWorkflowDeployment(spec);
    } catch (cause) {
      // Soft failure (this process survived, the deploy threw): drop the
      // record and release the slug so the failed deploy is neither restored
      // nor leaks its slug. The record delete must not mask the real deploy
      // error or skip releasing the slug: a rejecting delete is logged (the
      // orphaned record is a durable-state leak the next boot scan re-drives)
      // but `cause` is still what propagates and the slug is still released.
      try {
        await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        logger.error`deploy cleanup: deleteWorkflowDeploymentRecord failed for ${deploymentId}: ${message}`;
      }
      releaseSlug(deploymentId, frame.agentAddress);
      throw cause;
    } finally {
      // Release the single-flight reservation whether the deploy succeeded or
      // threw. On success the address is now in `activeSupervisors`, which the
      // guard also consults, so a later re-deploy is still rejected.
      reservingDeployAddresses.delete(frame.agentAddress);
    }
  }

  /**
   * Re-establish one persisted deployment from its on-disk record -- the
   * shared core of the boot-time restore loop and the CL-5477 idle-reap
   * wake path. Applies exactly the gates the live deploy path applies
   * (address integrity, wire arktype, tool-metadata-equivalent structural
   * projection, source admission). Soft-skips (corrupt record, failed
   * validation, unbuildable provider) log and return without spawning,
   * matching the boot scan's existing posture; the record is never deleted
   * here. Throws only where the spawn core itself throws.
   */
  async function restoreDeploymentFromRecord(
    dataDir: string,
    deploymentId: string,
    record: WorkflowDeploymentRecord,
  ): Promise<void> {
    // Integrity: the stored address must re-derive to its own directory
    // name. A mismatch means a corrupt or misplaced record; skip it
    // rather than restore a deployment under the wrong slug.
    const derived = deriveDeploymentId(record.agentAddress);
    if (derived !== deploymentId) {
      logger.warn`skipping workflow deployment restore: ${record.agentAddress} derives slug ${derived}, not its directory ${deploymentId}`;
      return;
    }

    // A record whose address the platform's own parser rejects is
    // permanently unrestorable -- it predates the current run-address
    // scheme (e.g. legacy "ins_" prefixes) and no later boot can ever
    // revive it. A wake never reaches this branch (a wake only fires for
    // an address the boot scan already accepted), but the boot restore
    // loop and this shared core must agree, so the check lives here once.
    if (!isRunAddress(record.agentAddress)) {
      await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
      logger.info`Pruned unrestorable workflow deployment record ${deploymentId} (legacy address ${record.agentAddress})`;
      return;
    }

    // Re-read and RE-VALIDATE the definition off disk with the exact
    // gates the deploy path applies: the wire arktype
    // (`AgentDeployWorkflow`) to narrow the untrusted on-disk shape,
    // then `validateWorkflowProjection` for the structural invariants
    // the arktype does not cover. The on-disk `workflow.json` is
    // untrusted at restore, so it must clear the same bar a fresh
    // deploy frame clears -- no weaker.
    const definitionRaw = await readWorkflowJson(dataDir, record.definitionId);
    const projection = AgentDeployWorkflow({
      definition: definitionRaw,
      sources: record.sources,
    });
    if (projection instanceof type.errors) {
      logger.warn`skipping workflow deployment restore for ${record.agentAddress}: workflow.json failed validation: ${projection.summary}`;
      return;
    }
    validateWorkflowProjection(projection);

    // Re-run the source-admission gate: refuse to restore a deployment
    // whose pinned provider this sidecar can no longer build. Every
    // source in a step's failover chain must be buildable, so this
    // iterates the whole list. The record is KEPT (not deleted) so a
    // later boot with the provider restored retries it.
    for (const stepId of projection.definition.stepOrder) {
      const chain = projection.sources[stepId];
      if (chain !== undefined) {
        for (const source of chain) deps.assertSourceBuildable(source);
      }
    }

    const spec: WorkflowDeploySpec = {
      agentAddress: record.agentAddress,
      definition: projection.definition,
      sources: projection.sources,
      sessionId: record.sessionId,
      hubPublicKey: record.hubPublicKey,
      referencedDefinitionHashes: record.referencedDefinitionHashes,
      // Frame-only, never persisted: a restore (boot-time OR a CL-5477
      // wake) waits for the hub's next `credentials.update` push, exactly
      // like a redeploy of a deployment that predates a credentials push.
      credentials: undefined,
    };

    // The slug is the caller's, matching `deployMultiStep`: claim before
    // the spawn, release on failure. Unlike deploy's soft-fail, restore
    // does NOT delete the record and does NOT re-materialize
    // `workflow.json` or the step grants -- all of that is already on
    // disk from the original deploy. A failed restore just warns and
    // leaves the record for the next boot; there is deliberately no GC
    // of a permanently-unrestorable record here (an operator reclaims it
    // by undeploying the address).
    //
    // Release only a slug THIS pass newly claimed: if the address is
    // already live (its slug still held by the running deployment), the
    // core's double-spawn guard throws, and freeing the slug then would
    // strand a live deployment's collision guard. `claimSlug` is a
    // no-op for an already-held (deploymentId, address) pair, so the
    // pre-claim check distinguishes the two. A PARKED deployment keeps
    // its slug claimed, so a wake respawn lands in this already-held arm.
    const slugNewlyClaimed =
      slugClaims.get(deploymentId) !== record.agentAddress;
    claimSlug(deploymentId, record.agentAddress);
    try {
      await spawnWorkflowDeployment(spec);
      logger.info`Restored workflow deployment for ${record.agentAddress}`;
    } catch (cause) {
      if (slugNewlyClaimed) {
        releaseSlug(deploymentId, record.agentAddress);
      }
      throw cause;
    }
  }

  /**
   * Ensure the deployment at `agentAddress` has a live supervisor,
   * respawning it from its persisted record if it is parked. Single-flight:
   * concurrent wakes for one address share one respawn. Resolves when the
   * supervisor is live (its real router handlers re-registered); throws if
   * the address has no restorable record or the respawn fails, in which
   * case the address stays parked with its wake handlers still registered
   * so a later frame retries.
   */
  async function ensureAwake(agentAddress: string): Promise<void> {
    if (routerShuttingDown) {
      throw new Error(
        `idle-reap wake: sidecar is shutting down; refusing to respawn ${agentAddress}`,
      );
    }
    // A park mid-teardown must fully release the transport key and
    // pack-push mapping before a respawn re-claims them, or the park's
    // finally would unregister the FRESH deployment's registrations out
    // from under it. Await the teardown (failure included -- the respawn
    // below re-establishes state regardless), then re-check liveness.
    const parking = parksInFlight.get(agentAddress);
    if (parking !== undefined) {
      await parking.catch(() => undefined);
    }
    if (activeSupervisors.has(agentAddress)) return;
    const inFlight = wakeInFlight.get(agentAddress);
    if (inFlight !== undefined) return await inFlight;
    const dataDir = stepStateDataDir;
    if (dataDir === undefined) {
      throw new Error(
        `idle-reap wake: no data dir is wired; cannot respawn ${agentAddress}`,
      );
    }
    const deploymentId = deriveDeploymentId(agentAddress);
    const wake = (async () => {
      const wakeStartedMs = Date.now();
      const record = await readWorkflowDeploymentRecord(dataDir, deploymentId);
      if (record === undefined) {
        throw new Error(
          `idle-reap wake: no restorable record for parked deployment ${agentAddress}`,
        );
      }
      await restoreDeploymentFromRecord(dataDir, deploymentId, record);
      // The restore core SOFT-SKIPS an invalid record (slug mismatch,
      // failed workflow.json validation, unbuildable provider) -- it warns
      // and returns without spawning. A wake must FAIL in that case, not
      // resolve: the wake handlers re-dispatch through the router on
      // success, and a "successful" wake that left no live supervisor
      // would re-enter the still-registered wake handler in an unbounded
      // loop. Restore-as-parked (boot) announces records it has not fully
      // validated, so this is the gate that keeps an announced-but-
      // unrestorable record to one logged failure per inbound frame.
      if (!activeSupervisors.has(agentAddress)) {
        throw new Error(
          `idle-reap wake: record for ${agentAddress} did not restore to a live supervisor (see restore warnings)`,
        );
      }
      // The wake-latency budget an operator watches: a user resuming a
      // parked thread eats this before their message dispatches.
      logger.info`Woke parked deployment ${agentAddress} in ${String(Date.now() - wakeStartedMs)}ms`;
    })();
    wakeInFlight.set(agentAddress, wake);
    try {
      await wake;
    } finally {
      wakeInFlight.delete(agentAddress);
    }
  }

  /**
   * Install the parked-state handlers for a deployment address on the
   * routers. Each wakes the deployment (respawning its child from the
   * persisted record) and then re-dispatches the frame through the router,
   * which by then holds the live handlers `spawnWorkflowDeployment`
   * registered. The respawn is what swaps these handlers out, so a wake
   * failure leaves them in place and the next frame retries.
   */
  function registerWakeHandlers(agentAddress: string): void {
    deps.multistepMailRouter?.register(agentAddress, async (message) => {
      // Waits for the wake (so the hub-link's `mail.inbound.ack` reflects a
      // real acceptance, matching the live handler's contract) but a wake
      // failure is logged and swallowed rather than rejected: a failed wake
      // leaves this handler registered so the NEXT frame retries the
      // respawn, and rejecting here would make the hub-link withhold the
      // ack for a message that may yet be delivered on retry. Whether THIS
      // message is redelivered depends on the hub's retry machinery, which
      // this layer does not control.
      try {
        await ensureAwake(agentAddress);
        await deps.multistepMailRouter?.tryRoute(agentAddress, message);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        logger.error`idle-reap wake on inbound mail failed for ${agentAddress}: ${reason}`;
      }
    });
    deps.multistepSignalRouter?.register(agentAddress, async (args) => {
      await ensureAwake(agentAddress);
      await deps.multistepSignalRouter?.tryRoute({
        type: "signal.deliver",
        agentAddress,
        runId: args.runId,
        signalName: args.signalName,
        signalId: args.signalId,
        payload: args.payload,
      });
    });
    deps.multistepDrainRouter?.register(agentAddress, async (_args) => {
      // A parked deployment has no child and no in-flight runs; a drain
      // against it is already satisfied. Waking it just to drain it would
      // spawn a large process in order to shut it down.
      logger.info`drain for parked deployment ${agentAddress}: nothing to drain`;
    });
    deps.multistepSourcesRouter?.register(agentAddress, async (args) => {
      // A rotation must land durably even while parked, so wake and
      // re-dispatch into the live handler, which persists the rotated
      // record and swaps the warm agent's sources.
      await ensureAwake(agentAddress);
      await deps.multistepSourcesRouter?.tryRoute({
        type: "sources.update",
        agentAddress,
        sources: args.sources,
        defaultSource: args.defaultSource,
      });
    });
    // Our sidecar's credentials router has no scout counterpart (CL-6194's
    // per-child material-cell push predates the upstream port): a parked
    // deployment must still wake for a rotation or revocation, or the
    // delivered material would silently be lost while parked.
    deps.multistepCredentialsRouter?.register(agentAddress, async (args) => {
      await ensureAwake(agentAddress);
      await deps.multistepCredentialsRouter?.tryRoute({
        type: "credentials.update",
        agentAddress,
        delivery: args.delivery,
      });
    });
  }

  /**
   * Park an idle deployment: tear down its supervisor and workflow-child
   * (reclaiming the child's memory) while keeping the persisted deployment
   * record, slug claim, and on-disk step state, so the next inbound frame
   * respawns it via `ensureAwake`. The wake handlers are swapped in BEFORE
   * the supervisor comes down so a frame racing the park wakes the
   * deployment instead of dropping at an unregistered address; `ensureAwake`
   * begins with the `activeSupervisors` check, and this function removes
   * the entry synchronously before its first await, so a racing wake cannot
   * observe the dying supervisor as live.
   *
   * Park does NOT delete the deployment record, does NOT remove the
   * per-step scratch directory, does NOT release the slug, does NOT forget
   * the agent's keys, and sends no hub frame -- every one of those is
   * `undeploy`'s job, not park's. Parking is purely an in-process resource
   * reclaim; to the hub and to disk, the deployment is still deployed.
   */
  function parkDeployment(agentAddress: string): Promise<void> {
    const existing = parksInFlight.get(agentAddress);
    if (existing !== undefined) return existing;
    const wired = activeSupervisors.get(agentAddress);
    if (wired === undefined) return Promise.resolve();
    const deploymentId = deriveDeploymentId(agentAddress);
    // Everything up to the first await runs synchronously, so a wake
    // observing `parksInFlight` (or missing the `activeSupervisors` entry)
    // sees a consistent parked-in-progress state, never the dying
    // supervisor as live.
    activeSupervisors.delete(agentAddress);
    parkedAddresses.set(agentAddress, deploymentId);
    lastActivityAt.delete(agentAddress);
    openRuns.delete(agentAddress);
    registerWakeHandlers(agentAddress);
    logger.info`Parking idle workflow deployment ${agentAddress}`;
    const park = (async () => {
      try {
        await shutdownSupervisorWithEscalation(wired);
      } finally {
        // Transport + pack-push registry come down AFTER the supervisor so
        // the child's final writes still resolve an address; the wake
        // respawn re-registers both through the ordinary spawn path.
        // `ensureAwake` awaits this whole teardown before respawning, so
        // these unregisters can never land on a freshly-woken deployment's
        // registrations.
        deps.transport.unregister(agentAddress);
        deps.unregisterDeployment({ deploymentId, agentAddress });
      }
    })();
    parksInFlight.set(agentAddress, park);
    void park.finally(() => {
      parksInFlight.delete(agentAddress);
    });
    return park;
  }

  function sweepIdleDeployments(idleReapMs: number): void {
    const now = Date.now();
    for (const agentAddress of [...activeSupervisors.keys()]) {
      // A deploy in flight for this address is activity by definition.
      if (reservingDeployAddresses.has(agentAddress)) continue;
      // Never park a deployment with an open run: see `openRuns`'s doc
      // comment.
      const open = openRuns.get(agentAddress);
      if (open !== undefined && open.size > 0) continue;
      const last = lastActivityAt.get(agentAddress);
      if (last === undefined) {
        // Pre-reap spawn (or a lost entry): start its idle clock now
        // rather than parking a deployment whose age is unknown.
        touchActivity(agentAddress);
        continue;
      }
      if (now - last < idleReapMs) continue;
      void parkDeployment(agentAddress).catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        logger.error`Failed to park idle deployment ${agentAddress}: ${reason}`;
      });
    }
  }

  if (deps.idleReapMs !== undefined && deps.idleReapMs > 0) {
    const idleReapMs = deps.idleReapMs;
    // Sweep at a quarter of the threshold, bounded to [1s, 60s], so
    // eviction latency stays close to the threshold without a hot loop.
    const sweepMs = Math.min(60_000, Math.max(1_000, idleReapMs / 4));
    idleSweepTimer = setInterval(() => {
      sweepIdleDeployments(idleReapMs);
    }, sweepMs);
    // Never hold the process open just to reap children.
    idleSweepTimer.unref?.();
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
      const deploymentId = deriveDeploymentId(frame.agentAddress);
      deps.multistepMailRouter?.unregister(frame.agentAddress);
      deps.multistepSignalRouter?.unregister(frame.agentAddress);
      deps.multistepDrainRouter?.unregister(frame.agentAddress);
      deps.multistepGrantsRouter?.unregister(frame.agentAddress);
      // Unregister unconditionally (a no-op for a multi-step address that
      // registered no sources handler), matching the sibling routers.
      deps.multistepSourcesRouter?.unregister(frame.agentAddress);
      deps.multistepCredentialsRouter?.unregister(frame.agentAddress);
      // With the routers down (no NEW wake can start), settle any in-flight
      // CL-5477 idle-reap transition: a wake that already read the record
      // would otherwise complete its spawn AFTER this teardown, resurrecting
      // the deployment as an announced orphan with no record. A completed
      // wake re-registered live router handlers via the spawn path, so the
      // routers come down a second time below; a completed park left parked
      // state the branch below reclaims.
      const inFlightWake = wakeInFlight.get(frame.agentAddress);
      if (inFlightWake !== undefined) {
        await inFlightWake.catch(() => undefined);
      }
      const inFlightPark = parksInFlight.get(frame.agentAddress);
      if (inFlightPark !== undefined) {
        await inFlightPark.catch(() => undefined);
      }
      deps.multistepMailRouter?.unregister(frame.agentAddress);
      deps.multistepSignalRouter?.unregister(frame.agentAddress);
      deps.multistepDrainRouter?.unregister(frame.agentAddress);
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
        openRuns.delete(frame.agentAddress);
        await wired.supervisor.shutdown();
        // Drop the deployment address's transport registration installed at
        // spawn (OUTBOUND half of mailbox ownership). Both single- and
        // multi-step register the deployment address for outbound signing, so
        // this tears down a real registration for either; `unregister` is a
        // no-op only if the spawn failed before registering, so it is safe to
        // call unconditionally for any spawned deployment.
        deps.transport.unregister(frame.agentAddress);
        // Reclaim the deployment's per-step local-disk scratch now that
        // its supervisor + workflow-process child are torn down. The
        // whole `workflow-step-state/<deploymentId>/` subtree goes: the
        // warm single-step agent's stable workspace under `warm/` (the
        // dir bounded keying parks per agent) AND any cold `runs/<runId>/`
        // subtrees a multi-step deploy's per-run cleanup did not already
        // drop. Awaiting `shutdown()` above guarantees no child still
        // holds the scratch, so this is a safe `rm -rf`. The durable
        // conversation under `agent-conversation-state/` is a DIFFERENT
        // root and is deliberately NOT touched here -- a re-deploy on the
        // same address must restore the prior conversation from it.
        if (stepStateDataDir !== undefined) {
          await rm(
            pathJoin(stepStateDataDir, "workflow-step-state", deploymentId),
            { recursive: true, force: true },
          );
        }
      }
      // A PARKED deployment (CL-5477) has no live supervisor, but its wake
      // handlers were just unregistered above and its transport registration
      // already came down at park time. Reclaim its scratch and parked-state
      // bookkeeping so the undeploy is as complete as the live-supervisor
      // branch's.
      if (parkedAddresses.delete(frame.agentAddress)) {
        if (stepStateDataDir !== undefined) {
          await rm(
            pathJoin(stepStateDataDir, "workflow-step-state", deploymentId),
            { recursive: true, force: true },
          );
        }
      }
      lastActivityAt.delete(frame.agentAddress);
      // Drop the deployment record so a boot-time restore does not re-spawn a
      // torn-down deployment. Runs on every undeploy -- not only when a
      // supervisor was active -- so a record left behind by a
      // crash-interrupted deploy is reclaimed too.
      if (stepStateDataDir !== undefined) {
        await deleteWorkflowDeploymentRecord(stepStateDataDir, deploymentId);
      }
      releaseSlug(deploymentId, frame.agentAddress);
      deps.unregisterDeployment({
        deploymentId,
        agentAddress: frame.agentAddress,
      });
    },
    async restoreWorkflowDeployments(): Promise<void> {
      const dataDir = stepStateDataDir;
      if (dataDir === undefined) {
        // No substrate config was wired (a test router that never spawns a
        // child): nothing was ever persisted under this data dir, so there
        // is nothing to restore.
        return;
      }

      const scanned = await scanWorkflowDeploymentRecords(dataDir);
      // Restore serially, not in parallel: deterministic boot-log ordering,
      // one isolable warning per failed record, and no concurrent
      // child-spawn / transport-register storm. Restore runs before
      // `hubLink.connect()`, so there are no concurrent deploys to contend
      // with. Each record's failure is caught so one bad deployment cannot
      // strand the rest.
      //
      // CL-5480: with reaping enabled, only a deployment active within the
      // reap window gets a live child at boot. Everything else restores AS
      // PARKED -- slug claimed, address announced, wake handlers registered,
      // zero process -- and wakes on its next inbound frame through the
      // CL-5477 wake path (which performs the full record validation the
      // live path does here). This bounds a boot's spawn cost to the active
      // window instead of the whole persisted fleet, and directly kills the
      // CL-6255 boot storm: a fleet of long-idle deployments restores with
      // zero spawned processes instead of respawning every one of them. A
      // missing marker (a deployment that never took a park-tracked turn, or
      // predates this marker) restores parked; the first message wakes it --
      // the conservative direction, since restoring live is always safe
      // (an idle one is swept later) while restoring parked something that
      // was actually active only costs one wake's latency on its next turn.
      const idleReapMs = deps.idleReapMs;
      const restoreParkedBefore =
        idleReapMs !== undefined && idleReapMs > 0
          ? Date.now() - idleReapMs
          : undefined;
      for (const { deploymentId, record } of scanned) {
        try {
          if (restoreParkedBefore !== undefined) {
            const activityMs = await readWorkflowDeploymentActivityMs(
              dataDir,
              deploymentId,
            );
            if (activityMs === undefined || activityMs < restoreParkedBefore) {
              // Same integrity gate the live path applies before any state
              // is claimed: a record whose address does not re-derive its
              // own directory is corrupt and must not claim a slug.
              const derived = deriveDeploymentId(record.agentAddress);
              if (derived !== deploymentId) {
                logger.warn`skipping workflow deployment restore: ${record.agentAddress} derives slug ${derived}, not its directory ${deploymentId}`;
                continue;
              }
              if (!isRunAddress(record.agentAddress)) {
                await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
                logger.info`Pruned unrestorable workflow deployment record ${deploymentId} (legacy address ${record.agentAddress})`;
                continue;
              }
              claimSlug(deploymentId, record.agentAddress);
              parkedAddresses.set(record.agentAddress, deploymentId);
              // Re-record the hub key a live restore would have recorded
              // at spawn, so a pre-wake hub-signed frame against this
              // address verifies exactly as it would against a
              // sweep-parked deployment (whose in-memory entry survived
              // the park).
              if (record.hubPublicKey !== undefined) {
                deps.keyStore.recordHubKey(
                  record.agentAddress,
                  record.hubPublicKey,
                );
              }
              registerWakeHandlers(record.agentAddress);
              logger.info`Restored workflow deployment ${record.agentAddress} as parked (idle beyond reap window)`;
              continue;
            }
          }
          await restoreDeploymentFromRecord(dataDir, deploymentId, record);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          logger.warn`Failed to restore workflow deployment ${deploymentId}: ${reason}`;
        }
      }
    },
    activeAddresses(): string[] {
      // `activeSupervisors` holds exactly the deployments with a live
      // supervisor; `parkedAddresses` (CL-5477) holds the idle-torn-down
      // ones. Both are announced to the hub -- a parked address still needs
      // its mail routed here so the wake handlers can respawn it on the
      // next frame -- so this is their union, not `activeSupervisors` alone.
      return [
        ...new Set([...activeSupervisors.keys(), ...parkedAddresses.keys()]),
      ];
    },
    async shutdownAll(): Promise<void> {
      // Process-exit drain, NOT an undeploy: every live supervisor is shut
      // down so each workflow-process child, its IPC pipes, and its
      // event-channel fd are released before the host exits, but every
      // deployment record, routing registration source of truth, and the
      // durable conversation root stay on disk untouched -- the next boot's
      // `restoreWorkflowDeployments` re-establishes each deployment from
      // them.
      //
      // Stop parking AND waking first: a park racing process shutdown would
      // tear state down under the supervisors this drain is trying to
      // settle, and a wake would spawn a fresh child that outlives the
      // drain (`ensureAwake` consults this flag).
      routerShuttingDown = true;
      if (idleSweepTimer !== undefined) {
        clearInterval(idleSweepTimer);
        idleSweepTimer = undefined;
      }
      // Await sweep-initiated parks already in flight: their supervisors
      // left `activeSupervisors` when the park began, so the snapshot below
      // no longer covers them, and abandoning them here could exit the
      // process with a child mid-kill and its unref'd escalation timer
      // never firing.
      await Promise.all(
        [...parksInFlight.values()].map((park) => park.catch(() => undefined)),
      );
      // Also settle wakes that passed the `routerShuttingDown` check before
      // the flip: a completed wake lands its supervisor in
      // `activeSupervisors`, so awaiting it BEFORE the snapshot below means
      // the fresh child is drained here rather than outliving the process.
      await Promise.all(
        [...wakeInFlight.values()].map((wake) => wake.catch(() => undefined)),
      );
      // Shutdowns run in parallel with escalation, mirroring `parkDeployment`
      // -- one wedged child cannot strand the rest of the drain.
      await Promise.all(
        [...activeSupervisors.entries()].map(async ([address, wired]) => {
          activeSupervisors.delete(address);
          try {
            await shutdownSupervisorWithEscalation(wired);
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            logger.warn`Drain: supervisor shutdown for ${address} failed: ${reason}`;
          }
        }),
      );
    },
  };
}
