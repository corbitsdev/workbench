// Per-agent harness lifecycle.
//
// SessionManager owns the cross-agent state (provisioned/sessions maps,
// the per-agent mail-commit queue, the last-checkpoint-hash buffer used
// to thread connector reply hashes into outbound mail commits) and the
// global transport handlers (addMessageSentHandler). Per-agent harness
// construction lives behind the HarnessBuilder seam, supplied by the
// host. The package itself depends only on the lifecycle infrastructure
// (transport interface, mail-audit store type, crypto provider type)
// and the stores from this same package — it does not pin the concrete
// tool, storage, authz, or inference packages the harness is wired up
// against. The host owns those.
//
// Construction split between this module and the builder:
//   - SessionManager handles: provisioned/sessions bookkeeping,
//     transport.register/unregister/getTransportFor, AgentCrypto
//     instantiation, the mail-commit queue, the addMessageSentHandler
//     subscription, the rollback path on builder failure.
//   - HarnessBuilder handles: storage + mailStore construction (from
//     the per-agent signer), authz wiring (grantsRef + authorize
//     closure), tool composition, harness construction.
// The boundary keeps the cross-agent state owned by SessionManager and
// the per-agent construction owned by the host. Pushing transport
// registration into the builder would break the invariant; pushing
// authz out of the builder would re-couple the package to authz.

import path from "node:path";

import { getLogger } from "@intx/log";
import { hexEncode } from "@intx/types";
import type { HubTransport } from "@intx/mail-memory";
import type { GrantRule } from "@intx/types/authz";
import type { DeployApplyErrorFrame } from "@intx/types/sidecar";
import type {
  ConnectorThreadState,
  CryptoProvider,
  HarnessConfig as AgentConfig,
  InboundMessage,
  InferenceEvent,
  InferenceSource,
  KeyPair,
} from "@intx/types/runtime";
import type { Harness } from "@intx/harness";

import type { AgentKeyEntry, AgentKeyStore } from "./agent-key-store";
import type { AgentRepoStore } from "./agent-repo-store";
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";
import { applyAssetPack as applyAssetPackFn } from "./apply-asset-pack";
import {
  assistantCycleFingerprint,
  createAssistantLoopGuard,
} from "./assistant-loop-guard";

const logger = getLogger(["interchange", "hub-agent", "session"]);

/**
 * Public session record. The grants ref and disposers live inside the
 * HarnessBundle the builder produced — they are not part of this type.
 */
export type AgentSession = {
  agentAddress: string;
  agentId: string;
  config: AgentConfig;
};

export type SessionEventSink = (
  agentAddress: string,
  sessionId: string,
  event: InferenceEvent,
) => void;

export type ConnectorStateSink = (
  agentAddress: string,
  state: ConnectorThreadState | null,
) => void;

export type DeployApplyErrorSink = (
  agentAddress: string,
  payload: Omit<DeployApplyErrorFrame, "type" | "agentAddress">,
) => void;

// WORKBENCH-LOCAL (CL-3149): host-observable signal that a mail-triggered wake
// terminally failed with the inbound message still parked. The hub acks the
// sender the instant it routes mail to the sidecar, so a wake that then fails
// would otherwise drop the parked message with no trace above an internal log.
// This sink turns that silent drop into a first-class failure the sidecar host
// owns (mirroring `DeployApplyErrorSink`); the message stays parked for a later
// trigger.
export type MailDeliveryFailedSink = (
  agentAddress: string,
  info: { parkedCount: number; cause: string },
) => void;

export type SessionManagerConfig = {
  transport: HubTransport;
  repoStore: AgentRepoStore;
  keyStore: AgentKeyStore;
  buildHarness: HarnessBuilder;
  /**
   * Per-agent crypto factory. Receives the agent's raw key pair and
   * returns a CryptoProvider bound to it. Keeps the package free of
   * `@intx/crypto`.
   */
  createAgentCrypto: (keyPair: KeyPair) => CryptoProvider;
  onEvent: SessionEventSink;
  onConnectorStateChanged: ConnectorStateSink;
  /**
   * Optional: emit a deploy-apply error frame to the hub when the
   * harness builder rejects an apply attempt. Wired by the sidecar
   * app to hub-link's frame channel. Hosts without tool-package
   * distribution can omit this.
   */
  onDeployApplyError?: DeployApplyErrorSink;
  /**
   * WORKBENCH-LOCAL (CL-3149): Optional: invoked when a wake triggered by
   * inbound mail exhausts its retries while the message is still parked, so
   * the silent drop becomes an observable failure the host can escalate.
   * Hosts that do not care can omit it.
   */
  onMailDeliveryFailed?: MailDeliveryFailedSink;
  // WORKBENCH-LOCAL (CL-3102): lazy-wake tuning. `restoreSessions` no
  // longer builds harnesses; the first inbound message (or explicit
  // session open) builds one on demand via `wakeAgent`, which retries a
  // failed build with bounded backoff. These knobs govern that retry and
  // the inbound-mail parking buffer, and let tests inject a synchronous
  // `sleep` so backoff is exercised without wall-clock waits.
  /** Deferred delay used between wake retries. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Max build attempts a single wake makes before rejecting (default 5). */
  wakeMaxAttempts?: number;
  /** Initial/floor wake-retry backoff delay (default 200ms). */
  wakeBaseDelayMs?: number;
  /** Upper bound the wake-retry backoff is clamped to (default 5000ms). */
  wakeMaxDelayMs?: number;
  /**
   * Max inbound messages parked per address while its harness builds
   * (default 256). Oldest is dropped with a warning when full.
   */
  maxParkedMail?: number;
  // WORKBENCH-LOCAL (CL-3103): idle-eviction tuning. `evictIdleSessions`
  // tears a live session down and returns the agent to `wakeable` when it
  // has had no activity for `idleEvictMs`, so the very next message rebuilds
  // it through the same wake rails with full conversation history (durable
  // in the isogit-backed repo store). Eviction is the inverse of wake.
  /**
   * Idle threshold in ms before a live session is evicted. `0` (the
   * default) disables eviction entirely — every session stays resident.
   */
  idleEvictMs?: number;
  /**
   * Clock used for activity timestamps and the idle comparison. Defaults
   * to `Date.now`; tests inject a fake clock so eviction is exercised
   * without wall-clock waits.
   */
  now?: () => number;
};

// WORKBENCH-LOCAL (CL-3103): idle-eviction disabled by default here; the
// sidecar host supplies the 60s production default (see apps/sidecar config).
const DEFAULT_IDLE_EVICT_MS = 0;

// WORKBENCH-LOCAL (CL-3102): wake-retry + parking defaults.
const DEFAULT_WAKE_MAX_ATTEMPTS = 5;
const DEFAULT_WAKE_BASE_DELAY_MS = 200;
const DEFAULT_WAKE_MAX_DELAY_MS = 5_000;
const DEFAULT_MAX_PARKED_MAIL = 256;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// WORKBENCH-LOCAL (CL-3102): thrown when an in-flight wake discovers the
// agent was destroyed (undeploy / challenge.failed) during the build.
// Never retried — the agent is gone, not transiently failing.
class WakeAbortedError extends Error {}

// WORKBENCH-LOCAL (CL-3339): thrown by `abortTurn` when the agent has no
// message run in flight (live-but-idle, sleeping, or unknown). The message
// carries the `no-active-turn` sentinel verbatim over the `session.error`
// frame so the hub can map it to a 409 rather than a gateway failure.
export const NO_ACTIVE_TURN = "no-active-turn";

export class NoActiveTurnError extends Error {
  constructor(agentAddress: string) {
    super(`${NO_ACTIVE_TURN}: no running turn for agent "${agentAddress}"`);
    this.name = "NoActiveTurnError";
  }
}

// WORKBENCH-LOCAL (CL-3339): extended abort reason for the user-initiated
// "stop this turn" action. NOT a member of upstream `AbortReason` — the hub
// route sends it over the same `session.abort` frame shape and hub-link
// decodes it with a local schema before the upstream frame union. Only this
// reason is non-terminal (abortTurn → evict-to-wakeable); `user_disconnect`
// and every other upstream reason keep their terminal kill semantics, so the
// native interchange abort route and the ops kill switch behave exactly as
// before. Pinned by tests on both sides (fork + hub route).
export const USER_STOP_TURN_REASON = "user_stop_turn";

export type ProvisionResult = {
  publicKey: string;
  keyPair: KeyPair;
};

export type RestoredAgent = {
  address: string;
  keyPair: KeyPair;
  hubPublicKey?: string;
};

export type RestoreResult = {
  restored: RestoredAgent[];
  failed: string[];
};

export type AgentEventListener = (event: InferenceEvent) => void;

export type SessionManager = {
  provisionAgent(config: AgentConfig): Promise<ProvisionResult>;
  startSession(agentAddress: string): Promise<void>;
  /**
   * WORKBENCH-LOCAL (CL-3102): build (or reuse) an agent's harness on
   * demand. Idempotent and de-duplicated: a concurrent call while a build
   * is in flight awaits the same build rather than starting a second one.
   * A build failure (e.g. the hub's credential endpoint briefly
   * unreachable during a co-deploy) is retried with bounded backoff; if
   * every attempt fails the returned promise rejects and the agent stays
   * wakeable for a later trigger. Resolves once the harness is running.
   *
   * With `awaitFirstAttemptOnly` the returned promise settles on the FIRST
   * attempt's outcome: a first-attempt failure rejects immediately while
   * the remaining retries continue in the background. Callers on a wire
   * deadline (the hub's session.start ack timeout) use this so a slow
   * retry schedule cannot outlive the deadline.
   */
  wakeAgent(
    agentAddress: string,
    opts?: { awaitFirstAttemptOnly?: boolean },
  ): Promise<void>;
  /**
   * WORKBENCH-LOCAL (CL-3102): true when the agent has been restored from
   * disk as routing metadata but its harness has not been built yet — the
   * lazy-restore state between a sidecar reconnect and the first inbound
   * message.
   */
  isWakeable(agentAddress: string): boolean;
  /**
   * WORKBENCH-LOCAL (CL-3103): evict every live session that has been idle
   * for at least `idleEvictMs`. The inverse of `wakeAgent`: the harness is
   * disposed (bundle disposers run, transport unregistered, heap reclaimed)
   * and the agent is returned to the `wakeable` state so the next inbound
   * message rebuilds it with full history from the durable repo store. A
   * session is NEVER evicted while a turn is running, an in-process event
   * subscriber is attached, mail is parked, a wake/build is in flight, or an
   * eviction is already under way. `idleEvictMs <= 0` makes this a no-op.
   * Resolves once all evictions started by this sweep have settled. Wired to
   * a periodic timer by the sidecar host.
   */
  evictIdleSessions(): Promise<void>;
  /**
   * WORKBENCH-LOCAL (CL-3102): deliver a raw inbound mail message to the
   * agent. A live session is delivered immediately; a wakeable (not-yet-
   * built) agent has the message parked and its harness woken, then the
   * parked messages are replayed into the freshly built harness in arrival
   * order. The trigger survives every in-process failure path (build
   * failure, retry, concurrent wake). If the wake retries exhaust while the
   * message is still parked, `onMailDeliveryFailed` fires so the failure is
   * observable to the host rather than silent, and the message stays parked
   * for a later trigger; it is lost only if the process crashes mid-wake —
   * the parked buffer is memory-only.
   */
  deliverInboundMail(agentAddress: string, rawMessage: Uint8Array): void;
  destroySession(agentAddress: string): Promise<void>;
  abortSession(agentAddress: string, reason: string): Promise<void>;
  /**
   * WORKBENCH-LOCAL (CL-3339): abort the in-flight turn without ending the
   * conversation. Closing the harness fires the reactor's abort path, which
   * cancels the running inference/tool call; the teardown is the idle-evict
   * one, so the agent returns to `wakeable` and the next message rebuilds it
   * with full history. Rejects with NoActiveTurnError when no turn is
   * running (the session, live or sleeping, is left untouched).
   */
  abortTurn(agentAddress: string): Promise<void>;
  deliverMessage(agentAddress: string, message: InboundMessage): void;
  updateGrants(agentAddress: string, grants: GrantRule[]): Promise<void>;
  /**
   * Subscribe to InferenceEvents scoped to a specific agent address.
   * Returns a disposer that removes the listener. Listeners fire
   * synchronously before the global `onEvent` sink during dispatch.
   * Production wires this against the workflow-host supervisor's
   * trivial-launch path so the per-message reactor brackets the
   * trivial workflow's run-event chain through `recordRunEvent`.
   */
  onAgentEvent(agentAddress: string, listener: AgentEventListener): () => void;
  updateSources(
    agentAddress: string,
    sources: InferenceSource[],
    defaultSource: string,
  ): Promise<void>;
  hasSession(agentAddress: string): boolean;
  isProvisioned(agentAddress: string): boolean;
  getAddresses(): string[];
  restoreSessions(): Promise<RestoreResult>;
  /**
   * Apply a deploy pack to the agent's repo. Thin wrapper around
   * AgentRepoStore for callers that already have a SessionManager handle.
   */
  applyDeployPack(
    agentAddress: string,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
    transferId: string,
    verifyCommit?: (payload: string, signature: string) => Promise<boolean>,
  ): Promise<void>;
  /**
   * Materialize an asset pack at `<workspaceRoot>/<mountPath>/` for the
   * agent. The workspace root is per-agent; this is distinct from the
   * agent's deploy git tree. Asset packs are unsigned in v1 — no
   * `verifyCommit` parameter.
   */
  applyAssetPack(
    agentAddress: string,
    mountPath: string,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
  ): Promise<void>;
  createStatePack(
    agentAddress: string,
  ): Promise<{ pack: Uint8Array; commitSha: string; ref: string }>;
  deleteAgentDir(agentAddress: string): Promise<void>;
  getDeployRef(agentAddress: string): Promise<string | null>;
  persistHubPublicKey(
    agentAddress: string,
    hubPublicKey: string,
  ): Promise<void>;
  commitInboundMail(
    agentAddress: string,
    rawMessage: Uint8Array,
  ): Promise<void>;
  getSessionId(agentAddress: string): string | undefined;
};

type ProvisionedAgent = {
  config: AgentConfig;
  keyPair: KeyPair;
};

// WORKBENCH-LOCAL (CL-3102): everything `wakeAgent` needs to build a
// restored agent's harness on demand, captured at restore time so the
// wake path never re-reads disk until the build itself runs. The hub
// pairing key is not carried here — hub-link replays it into the key
// store from the RestoredAgent list at reconnect time.
type WakeableAgent = {
  config: AgentConfig;
  keyPair: KeyPair;
};

type LiveSession = AgentSession & {
  harness: Harness;
  bundle: HarnessBundle;
  // WORKBENCH-LOCAL (CL-3103): retained so idle eviction can return the
  // agent to `wakeable` (which needs the key pair) without re-reading disk.
  keyPair: KeyPair;
  // WORKBENCH-LOCAL (CL-3339): the session's event pipeline (bookkeeping +
  // listeners + hub forwarder), retained so `abortTurn` can settle each open
  // run with a synthetic failed `message.run.ended` before teardown.
  emitEvent: (event: InferenceEvent) => void;
};

export function createSessionManager(
  config: SessionManagerConfig,
): SessionManager {
  const {
    transport,
    repoStore,
    keyStore,
    buildHarness,
    createAgentCrypto,
    onEvent,
    onConnectorStateChanged,
    onDeployApplyError,
    onMailDeliveryFailed,
    // WORKBENCH-LOCAL (CL-3102): lazy-wake tuning.
    sleep = defaultSleep,
    wakeMaxAttempts = DEFAULT_WAKE_MAX_ATTEMPTS,
    wakeBaseDelayMs = DEFAULT_WAKE_BASE_DELAY_MS,
    wakeMaxDelayMs = DEFAULT_WAKE_MAX_DELAY_MS,
    maxParkedMail = DEFAULT_MAX_PARKED_MAIL,
    // WORKBENCH-LOCAL (CL-3103): idle-eviction tuning.
    idleEvictMs = DEFAULT_IDLE_EVICT_MS,
    now = Date.now,
  } = config;
  if (!Number.isInteger(wakeMaxAttempts) || wakeMaxAttempts < 1) {
    throw new Error(
      `createSessionManager: wakeMaxAttempts must be a positive integer; got ${String(wakeMaxAttempts)}`,
    );
  }

  const sessions = new Map<string, LiveSession>();
  const provisioned = new Map<string, ProvisionedAgent>();
  const pending = new Set<string>();

  // WORKBENCH-LOCAL (CL-3102): lazy-restore state.
  //   `wakeable`  — agents restored from disk as routing metadata whose
  //                 harness has not been built. Holds exactly what
  //                 `wakeAgent` needs to build without re-scanning disk.
  //   `waking`    — in-flight builds, keyed by address, so concurrent
  //                 wake triggers share one build instead of racing.
  //   `parkedMail`— inbound messages received while a harness is building,
  //                 replayed in arrival order once it is ready.
  const wakeable = new Map<string, WakeableAgent>();
  const waking = new Map<string, Promise<void>>();
  const parkedMail = new Map<string, Uint8Array[]>();
  // Per-wake ownership token. A superseding actor (provisionAgent for a
  // fresh deploy) flips `superseded` so the in-flight wake discards its
  // own build instead of installing it — and never tears down a session
  // it does not own.
  const wakeTokens = new Map<string, { superseded: boolean }>();

  // WORKBENCH-LOCAL (CL-3103): idle-eviction bookkeeping.
  //   `lastActivityAt` — per live session, the clock time of the most
  //                      recent activity (any inference event, inbound mail
  //                      delivery, or the moment the session went live).
  //   `activeRuns`     — per live session, the count of message runs
  //                      currently in flight (bracketed by
  //                      `message.run.started` / `message.run.ended`). A
  //                      turn — including its tool execution, which emits no
  //                      inference events — keeps this above zero, so the
  //                      idle sweep never tears an agent down mid-turn.
  //   `evicting`       — in-flight evictions keyed by address, so a second
  //                      sweep, a destroy, or inbound mail coordinates with
  //                      the teardown instead of racing it.
  const lastActivityAt = new Map<string, number>();
  const activeRuns = new Map<string, number>();
  const evicting = new Map<string, Promise<void>>();

  // WORKBENCH-LOCAL (CL-3339): turn-abort bookkeeping.
  //   `openRuns`     — per live session, the in-flight message runs
  //                    (messageRunId → messageId), so an abort can settle
  //                    each one with a synthetic failed `message.run.ended`
  //                    instead of leaving the hub's turn projection dangling
  //                    on an unanswered bracket-open.
  //   `lastEventSeq` — per live session, the highest event seq observed, so
  //                    the synthetic close events extend the stream
  //                    monotonically.
  const openRuns = new Map<string, Map<string, string>>();
  const lastEventSeq = new Map<string, number>();

  function markActivity(agentAddress: string): void {
    if (sessions.has(agentAddress)) lastActivityAt.set(agentAddress, now());
  }

  // Per-agent InferenceEvent fan-out. Subscribers register against a
  // specific agentAddress; the dispatch site looks the listener set up
  // by the event's owning address (the closure captured in startSession)
  // and fires every listener synchronously before the global `onEvent`
  // sink runs. Disposers remove a single listener and prune the set on
  // emptiness so addresses without subscribers cost a single map miss.
  const agentEventListeners = new Map<string, Set<AgentEventListener>>();

  function onAgentEvent(
    agentAddress: string,
    listener: AgentEventListener,
  ): () => void {
    let set = agentEventListeners.get(agentAddress);
    if (set === undefined) {
      set = new Set();
      agentEventListeners.set(agentAddress, set);
    }
    set.add(listener);
    return () => {
      const current = agentEventListeners.get(agentAddress);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) agentEventListeners.delete(agentAddress);
    };
  }

  // Checkpoint hash captured from the most recent connector.reply event for
  // each agent. Consumed (deleted) by the MessageSentHandler so that only
  // the connector reply mail commit receives the linkage — subsequent
  // tool-initiated sends do not carry a stale hash.
  //
  // Ordering guarantee: the harness calls onEvent() synchronously inside
  // handleEvent(), which fires before the detached transport.send() resolves.
  // Because executeSend() always awaits at least once (signature generation)
  // before calling MessageSentHandler, the map write in onEvent completes
  // before the handler reads it.
  const lastCheckpointHashes = new Map<string, string>();

  // WORKBENCH-LOCAL (CL-3340): assistant output loop guard.
  //   `assistantLoopGuard` — per-agent run of consecutive identical
  //                          normalized assistant outputs; reset by any
  //                          inbound user message and at session go-live.
  //   `loopInterrupted`    — agents whose turn was interrupted; remaining
  //                          events from the aborting reactor are dropped so
  //                          the synthetic run-ended stays the turn's last
  //                          word. Cleared when a session goes live again —
  //                          or immediately if the eviction fails, so a
  //                          still-live session is never left muted.
  // Open-run settlement reuses the shared `openRuns` bracket map declared
  // above (the turn-abort plumbing tracks the same brackets).
  const assistantLoopGuard = createAssistantLoopGuard();
  const loopInterrupted = new Set<string>();

  // WORKBENCH-LOCAL (CL-3340): stop the turn on a detected output loop. The
  // reactor exposes no per-cycle cancellation, so the stop lever is the
  // eviction teardown: the harness close aborts the reactor and flushes
  // conversation state, and the agent returns to `wakeable` — the next user
  // message rebuilds it with full history, so the session stays usable. A
  // synthetic failed run-ended (kind "assistant_loop_interrupted") settles
  // the turn hub-side with the explanation.
  function interruptAssistantLoop(
    agentAddress: string,
    sessionId: string,
    seq: number,
    message: string,
  ): void {
    loopInterrupted.add(agentAddress);
    const runs = openRuns.get(agentAddress);
    openRuns.delete(agentAddress);
    activeRuns.delete(agentAddress);
    // Settle every open bracket so no turn dangles hub-side (the reactor
    // serializes runs, so normally this is exactly one).
    if (runs !== undefined) {
      for (const [messageRunId, messageId] of runs) {
        const ended: InferenceEvent = {
          type: "message.run.ended",
          seq,
          data: {
            messageRunId,
            messageId,
            status: "failed",
            error: { message, kind: "assistant_loop_interrupted" },
          },
        };
        const set = agentEventListeners.get(agentAddress);
        if (set !== undefined) {
          for (const listener of set) {
            try {
              listener(ended);
            } catch (err: unknown) {
              logger.error`agent-event listener for ${agentAddress} threw during loop interrupt: ${String(err)}`;
            }
          }
        }
        onEvent(agentAddress, sessionId, ended);
      }
    }
    const session = sessions.get(agentAddress);
    if (session === undefined) return;
    logger.warn`Assistant output loop detected for ${agentAddress}; interrupting the turn and putting the session to sleep`;
    void evictSession(agentAddress, session, "loop-interrupt").catch(
      (err: unknown) => {
        // A failed teardown leaves the session live — unmute it rather than
        // leaving a deaf zombie until the idle sweep.
        loopInterrupted.delete(agentAddress);
        logger.error`Loop-interrupt eviction for ${agentAddress} failed; resuming event forwarding: ${String(err)}`;
      },
    );
  }

  // Per-agent promise chain that serializes the operations against an agent's
  // on-disk directory that can be in flight during a live session -- mail-audit
  // commits, state-pack and deploy-ref reads, and deploy/asset-pack applies all
  // run one-at-a-time per agent. The chain exists for teardown: drainRepoOps
  // awaits it before deleting the directory, so an operation that was valid
  // when it started never runs against a path that has since vanished
  // underneath it. Serializing additionally avoids corruption for the members
  // that share the agent's `.git/` object store (mail commits, state-pack and
  // deploy-ref reads, deploy-pack applies), which isogit, lacking a
  // cross-process lock, would otherwise let interleave. Asset-pack applies are
  // on the chain only for the teardown reason -- they materialize into a
  // workspace subtree, not the agent repo's object store.
  const repoOpQueues = new Map<string, Promise<void>>();

  function runRepoOp<T>(
    agentAddress: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = repoOpQueues.get(agentAddress) ?? Promise.resolve();
    // Run fn once prev settles. prev is either the initial Promise.resolve()
    // or the rejection-swallowing tail stored below, so it never rejects;
    // passing fn as both the fulfilled and rejected handler keeps this op
    // independent of that detail and guarantees fn runs exactly once after the
    // previous op completes.
    const result = prev.then(fn, fn);
    // Store a rejection-swallowing tail so one failed op does not poison the
    // chain for the next caller. The caller still observes this op's own
    // result or rejection through `result`.
    repoOpQueues.set(
      agentAddress,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  function enqueueMailCommit(
    agentAddress: string,
    fn: () => Promise<void>,
  ): void {
    void runRepoOp(agentAddress, fn).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Mail audit commit failed for ${agentAddress}: ${msg}`;
    });
  }

  // Await the agent's current operation chain so teardown removes the
  // directory only after in-flight git work finishes. Capturing the tail and
  // clearing the entry means an op enqueued AFTER this point starts a fresh
  // chain this drain does not await. That is safe only because every caller
  // invokes runRepoOp synchronously, before its first await, inside the
  // serialized frame dispatch -- so by the time a later agent.undeploy frame
  // reaches deleteAgentDir, every racing op is already on the chain. A handler
  // that deferred its runRepoOp call past an await would reopen the
  // delete-under-in-flight-op race.
  async function drainRepoOps(agentAddress: string): Promise<void> {
    const inflight = repoOpQueues.get(agentAddress);
    repoOpQueues.delete(agentAddress);
    if (inflight !== undefined) await inflight;
  }

  transport.addMessageSentHandler(
    async ({ senderAddress, rawMessage, messageId }) => {
      const session = sessions.get(senderAddress);
      if (session === undefined) {
        // Outbound mail for an address with no active session is a
        // protocol violation — the transport should not have accepted
        // the send. Surfacing this loudly catches the contract break
        // before it propagates as silently-dropped audit records.
        throw new Error(
          `No active session for sender "${senderAddress}" — cannot audit outbound mail ${messageId}`,
        );
      }
      const mailStore = session.bundle.mailStore;
      const checkpointHash = lastCheckpointHashes.get(senderAddress);
      lastCheckpointHashes.delete(senderAddress);
      enqueueMailCommit(senderAddress, async () => {
        const result = await mailStore.commitMail(rawMessage, "out", {
          ignoreDuplicate: true,
          ...(checkpointHash !== undefined ? { checkpointHash } : {}),
        });
        if (result !== null) {
          logger.info`Committed outbound mail ${messageId} for ${senderAddress}`;
        }
      });
    },
  );

  async function provisionAgent(
    agentConfig: AgentConfig,
  ): Promise<ProvisionResult> {
    const { agentAddress } = agentConfig;

    if (
      sessions.has(agentAddress) ||
      provisioned.has(agentAddress) ||
      pending.has(agentAddress)
    ) {
      throw new Error(`Agent already exists for address "${agentAddress}"`);
    }

    pending.add(agentAddress);
    // WORKBENCH-LOCAL (CL-3102): a fresh (re)provision supersedes any
    // lazy-restore metadata for this address — the incoming config is
    // authoritative, so drop the stale wakeable entry and any mail parked
    // against the pre-provision harness. An in-flight wake is marked
    // superseded so it discards its own build result on completion
    // instead of installing a session for the pre-provision config.
    wakeable.delete(agentAddress);
    parkedMail.delete(agentAddress);
    const inflightToken = wakeTokens.get(agentAddress);
    if (inflightToken !== undefined) inflightToken.superseded = true;

    try {
      const { keyPair, isNew } = await keyStore.loadOrGenerateKey(agentAddress);

      if (isNew) {
        logger.info`Generated new key pair for ${agentAddress}`;
      }

      await repoStore.initRepo(agentAddress);
      await repoStore.persistConfig(agentAddress, agentConfig);

      provisioned.set(agentAddress, { config: agentConfig, keyPair });

      const publicKey = hexEncode(keyPair.publicKey);
      logger.info`Provisioned agent ${agentAddress}`;
      return { publicKey, keyPair };
    } finally {
      pending.delete(agentAddress);
    }
  }

  // WORKBENCH-LOCAL (CL-3102): public startSession waits out a doomed
  // in-flight wake first. A fresh deploy racing a wake (provisionAgent
  // marked the wake superseded) must not start a second concurrent build
  // for the same address — the wake still owns the transport registration
  // until it discards its own build. The wake path itself calls
  // startSessionCore directly (awaiting `waking` here would deadlock on
  // its own entry).
  async function startSession(agentAddress: string): Promise<void> {
    const inflight = waking.get(agentAddress);
    if (inflight !== undefined) {
      // The settle outcome is irrelevant here (an aborted wake is the
      // expected case); only the unwind matters.
      await inflight.catch(() => undefined);
    }
    await startSessionCore(agentAddress);
    // Mail parked against the ADDRESS while a doomed (superseded) wake was
    // unwinding belongs to this fresh session — the doomed wake exits via
    // the abort path and never reaches its own drain. Draining here makes
    // the ownership uniform: whoever brings the address live replays the
    // residue. (The wake path drains in performWake's success arm; it must
    // NOT drain in startSessionCore, where a doomed build would replay
    // mail into a session about to be discarded.)
    drainParkedMail(agentAddress);
  }

  async function startSessionCore(agentAddress: string): Promise<void> {
    const entry = provisioned.get(agentAddress);
    if (entry === undefined) {
      throw new Error(`No provisioned agent for address "${agentAddress}"`);
    }
    if (sessions.has(agentAddress)) {
      throw new Error(`Session already running for agent "${agentAddress}"`);
    }

    const { config: agentConfig, keyPair } = entry;

    const source = agentConfig.sources.find(
      (s) => s.id === agentConfig.defaultSource,
    );
    if (source === undefined) {
      throw new Error(
        `No source matches defaultSource "${agentConfig.defaultSource}" for agent "${agentAddress}"`,
      );
    }
    buildHarness.canBuildSource(source);

    provisioned.delete(agentAddress);

    try {
      const crypto = createAgentCrypto(keyPair);
      transport.register(agentAddress, crypto);
      const agentTransport = transport.getTransportFor(agentAddress);

      const sessionId = agentConfig.sessionId;
      const storeDir = repoStore.getAgentDir(agentAddress);

      // Named (not inline) so the LiveSession can retain it: `abortTurn`
      // (WORKBENCH-LOCAL CL-3339) replays a synthetic failed
      // `message.run.ended` through the exact pipeline real events take —
      // bookkeeping, per-agent listeners, and the global hub forwarder.
      const emitEvent = (event: InferenceEvent): void => {
        // WORKBENCH-LOCAL (CL-3340): a loop-interrupted agent's reactor is
        // being torn down; drop its remaining events so the synthetic
        // run-ended is the last thing the hub sees for the turn.
        if (loopInterrupted.has(agentAddress)) return;
        // WORKBENCH-LOCAL (CL-3103): every event is activity, and the
        // message-run bracket is the turn-in-progress signal the idle
        // sweep consults. `message.run.started` / `message.run.ended`
        // span the whole turn — including tool execution, which emits no
        // inference events — so a long tool call cannot look idle.
        lastActivityAt.set(agentAddress, now());
        // WORKBENCH-LOCAL (CL-3339): track the open runs and the stream's
        // seq high-water mark so an abort can settle each run in place.
        lastEventSeq.set(
          agentAddress,
          Math.max(lastEventSeq.get(agentAddress) ?? 0, event.seq),
        );
        if (event.type === "message.run.started") {
          activeRuns.set(agentAddress, (activeRuns.get(agentAddress) ?? 0) + 1);
          let runs = openRuns.get(agentAddress);
          if (runs === undefined) {
            runs = new Map();
            openRuns.set(agentAddress, runs);
          }
          runs.set(event.data.messageRunId, event.data.messageId);
        } else if (event.type === "message.run.ended") {
          const remaining = (activeRuns.get(agentAddress) ?? 0) - 1;
          if (remaining > 0) activeRuns.set(agentAddress, remaining);
          else activeRuns.delete(agentAddress);
          const runs = openRuns.get(agentAddress);
          if (runs !== undefined) {
            runs.delete(event.data.messageRunId);
            if (runs.size === 0) openRuns.delete(agentAddress);
          }
        }
        if (
          event.type === "connector.reply" &&
          event.data.checkpointHash !== undefined
        ) {
          lastCheckpointHashes.set(agentAddress, event.data.checkpointHash);
        }
        // WORKBENCH-LOCAL (CL-3340): check each finalized inference cycle for
        // a stuck identical response. The tripping duplicate is swallowed —
        // the interrupt's synthetic run-ended settles the turn instead.
        if (event.type === "inference.done") {
          const interrupt = assistantLoopGuard.recordAssistantOutput(
            agentAddress,
            assistantCycleFingerprint(event.data.turn.content),
          );
          if (interrupt !== undefined) {
            interruptAssistantLoop(
              agentAddress,
              sessionId,
              event.seq,
              interrupt,
            );
            return;
          }
        }
        // Per-agent listeners fire before the global sink so an
        // in-process consumer (the workflow-host trivial-launch
        // subscriber) sees events at the same instant the hub
        // forwarder does. Exceptions from a listener must not
        // suppress the global forwarder; collect and rethrow only
        // after `onEvent` has run.
        let firstError: unknown;
        const set = agentEventListeners.get(agentAddress);
        if (set !== undefined) {
          for (const listener of set) {
            try {
              listener(event);
            } catch (err: unknown) {
              if (firstError === undefined) firstError = err;
              else
                logger.error`agent-event listener for ${agentAddress} threw: ${String(err)}`;
            }
          }
        }
        onEvent(agentAddress, sessionId, event);
        if (firstError !== undefined) throw firstError;
      };

      const bundle = await buildHarness.build({
        agentAddress,
        agentConfig,
        sources: agentConfig.sources,
        defaultSource: agentConfig.defaultSource,
        storeDir,
        agentTransport,
        crypto,
        onEvent: emitEvent,
        onConnectorStateChanged(state) {
          onConnectorStateChanged(agentAddress, state);
        },
        ...(onDeployApplyError !== undefined
          ? {
              emitDeployApplyError: (payload) => {
                onDeployApplyError(agentAddress, payload);
              },
            }
          : {}),
      });

      sessions.set(agentAddress, {
        agentAddress,
        agentId: agentConfig.agentId,
        config: agentConfig,
        harness: bundle.harness,
        bundle,
        keyPair,
        emitEvent,
      });
      // WORKBENCH-LOCAL (CL-3340): a fresh harness starts with a clean loop
      // run, and a rebuilt (woken) session must forward events again.
      loopInterrupted.delete(agentAddress);
      assistantLoopGuard.reset(agentAddress);
      // WORKBENCH-LOCAL (CL-3103): seed the idle clock at go-live so a
      // session that never sees mail is still eligible for eviction once the
      // threshold elapses.
      lastActivityAt.set(agentAddress, now());

      // The composition-layer harness is started by `createHarness` --
      // by the time the builder returns the bundle, the agent's
      // reactor is already running. No separate start() step.
      logger.info`Started session for ${agentAddress} (session ${sessionId})`;
    } catch (err) {
      sessions.delete(agentAddress);
      repoOpQueues.delete(agentAddress);
      try {
        transport.unregister(agentAddress);
      } catch (cleanupErr) {
        // Best-effort cleanup; don't mask the original error.
        logger.error`Failed to unregister transport for ${agentAddress}: ${String(cleanupErr)}`;
      }
      // WORKBENCH-LOCAL (CL-3102): restore only into an empty slot. This
      // start's own entry was deleted above, so a present entry belongs
      // to a superseding provisionAgent that landed during the build —
      // clobbering it would brick the new deploy's session.start.
      if (!provisioned.has(agentAddress)) {
        provisioned.set(agentAddress, entry);
      }
      throw err;
    }
  }

  async function runDisposers(
    session: LiveSession,
    agentAddress: string,
  ): Promise<Error[]> {
    // Run every disposer even if some fail; an exception from one must
    // not leak the others. Errors are collected and returned so the
    // caller (destroy / abort) can decide whether to surface a
    // partial-teardown condition; today the caller logs the summary
    // and continues, since session teardown is also invoked from
    // recovery paths where a thrown aggregate would obscure the
    // original failure.
    const errors: Error[] = [];
    for (const disposer of session.bundle.disposers) {
      try {
        await disposer();
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error`Disposer failed for ${agentAddress}: ${e.message}`;
        errors.push(e);
      }
    }
    return errors;
  }

  // WORKBENCH-LOCAL (CL-2813): Bun/mimalloc does not return a torn-down agent's
  // freed heap to the OS on its own, so sidecar RSS climbs to peak concurrent
  // load and holds (measured: fresh 422MB → 6.4GB, flat). Force a GC after each
  // full session teardown (reaper eviction, instance delete, redeploy) so memory
  // tracks live agents. Guarded for any non-Bun import context.
  // WORKBENCH-LOCAL (CL-3233): log rss/heapUsed across the forced GC at the
  // exact teardown point. Bun/mimalloc can free the JS heap without returning
  // pages to the OS, so an idle-evicted session may leave RSS pinned at its
  // high-water-mark. Measuring here is the only reliable classifier: a heapUsed
  // drop with flat rss = allocator retention (needs a decommit/recycle fix);
  // both flat = references still held (a disposal leak). The periodic 60s
  // memory logger cannot attribute a change to a specific eviction.
  function reclaimHeap(context: string): void {
    const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
    if (bun?.gc === undefined) return;
    const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
    const before = process.memoryUsage();
    bun.gc(true);
    const after = process.memoryUsage();
    logger.info`Reclaim heap (${context}) rss ${String(mb(before.rss))}->${String(mb(after.rss))}MB heapUsed ${String(mb(before.heapUsed))}->${String(mb(after.heapUsed))}MB`;
  }

  async function destroySession(agentAddress: string): Promise<void> {
    // WORKBENCH-LOCAL (CL-3103): let an in-flight eviction settle first. It
    // ends with the agent `wakeable`, which the branches below drop cleanly;
    // tearing down mid-eviction would double-close the harness.
    await awaitEviction(agentAddress);
    if (provisioned.has(agentAddress)) {
      provisioned.delete(agentAddress);
      // WORKBENCH-LOCAL (CL-3102): also drop any lazy-restore state so
      // later mail cannot resurrect the destroyed agent.
      wakeable.delete(agentAddress);
      parkedMail.delete(agentAddress);
      logger.info`Removed provisioned agent ${agentAddress}`;
      return;
    }
    // WORKBENCH-LOCAL (CL-3102): a lazily-restored agent that was never
    // woken has no harness or transport registration to tear down — drop
    // its restore metadata and any parked mail so undeploy/challenge.failed
    // paths complete cleanly.
    if (wakeable.has(agentAddress)) {
      wakeable.delete(agentAddress);
      parkedMail.delete(agentAddress);
      logger.info`Removed wakeable agent ${agentAddress}`;
      return;
    }
    const session = sessions.get(agentAddress);
    if (session === undefined) {
      throw new Error(`No session exists for agent "${agentAddress}"`);
    }
    await destroyLiveSession(agentAddress, session, "destroy");
  }

  // WORKBENCH-LOCAL (CL-3102): session-only teardown, factored out of
  // destroySession so the wake's abort path can discard exactly the
  // session it built without touching the provisioned/wakeable early
  // branches (which may now belong to a superseding deploy).
  async function destroyLiveSession(
    agentAddress: string,
    session: LiveSession,
    context: "destroy" | "idle-evict" | "wake-abort" | "loop-interrupt",
  ): Promise<void> {
    await session.harness.close();
    const disposerErrors = await runDisposers(session, agentAddress);
    await drainRepoOps(agentAddress);
    // Delete only if the map still points at OUR session; a concurrent
    // replacement must not be evicted by this teardown.
    if (sessions.get(agentAddress) === session) {
      sessions.delete(agentAddress);
      transport.unregister(agentAddress);
      // WORKBENCH-LOCAL (CL-3103): drop idle bookkeeping for the gone session.
      lastActivityAt.delete(agentAddress);
      activeRuns.delete(agentAddress);
      // WORKBENCH-LOCAL (CL-3339): and the turn-abort bookkeeping.
      openRuns.delete(agentAddress);
      lastEventSeq.delete(agentAddress);
    }
    if (disposerErrors.length > 0) {
      logger.warn`Stopped session for ${agentAddress} with ${String(disposerErrors.length)} disposer failure(s)`;
    } else {
      logger.info`Stopped session for ${agentAddress}`;
    }
    reclaimHeap(`${context} ${agentAddress}`);
  }

  // WORKBENCH-LOCAL (CL-3103): idle eviction — the inverse of `wakeAgent`.
  // A live session with no activity for `idleEvictMs` is torn down (harness
  // closed so its conversation state flushes to the durable repo store,
  // disposers run, transport unregistered, heap reclaimed) and the agent is
  // returned to `wakeable`, so the next inbound message rebuilds it through
  // the existing wake rails with full history. Eviction preserves the
  // conversation: no `endedAt` stamp, no conversation-ended event, no
  // `deleteAgentDir` — only session-scoped teardown, exactly like a sleep.
  async function awaitEviction(agentAddress: string): Promise<void> {
    const inflight = evicting.get(agentAddress);
    if (inflight !== undefined) await inflight.catch(() => undefined);
  }

  // WORKBENCH-LOCAL (CL-3149): a wake that drains parked inbound mail can
  // terminally fail on either wake-triggering path (mail arriving to a
  // sleeping agent, or the post-eviction replay). A WakeAbortedError means the
  // agent was destroyed/superseded — not a stuck message, so it is not a
  // delivery failure. A genuine terminal failure with mail still parked is the
  // silent-drop case: surface it so the sender-acked message is observably
  // undelivered rather than lost in a log.
  function reportTerminalWakeFailure(agentAddress: string, err: unknown): void {
    if (err instanceof WakeAbortedError) return;
    const parkedCount = parkedMail.get(agentAddress)?.length ?? 0;
    if (parkedCount > 0) {
      const cause = err instanceof Error ? err.message : String(err);
      onMailDeliveryFailed?.(agentAddress, { parkedCount, cause });
    }
  }

  async function performEvict(
    agentAddress: string,
    session: LiveSession,
    reason: EvictReason,
  ): Promise<void> {
    const { config: evictedConfig, keyPair } = session;
    // destroyLiveSession flushes conversation state via harness.close(),
    // runs disposers, drains repo ops, unregisters the transport, and
    // reclaims the heap — the same teardown wake will rebuild from.
    await destroyLiveSession(agentAddress, session, reason);
    // Only return to wakeable if nothing else claimed the address during the
    // teardown (a racing provision/deploy/undeploy). Clobbering a fresh
    // provisioned/wakeable entry would brick the new deploy.
    if (
      sessions.has(agentAddress) ||
      provisioned.has(agentAddress) ||
      wakeable.has(agentAddress) ||
      pending.has(agentAddress)
    ) {
      return;
    }
    wakeable.set(agentAddress, { config: evictedConfig, keyPair });
    // WORKBENCH-LOCAL (CL-3340): name the eviction cause — a loop interrupt
    // must not read as idle sleep in the logs.
    if (reason === "loop-interrupt") {
      logger.warn`Evicted agent ${agentAddress} after assistant output loop interrupt`;
    } else {
      logger.info`Evicted idle agent ${agentAddress}`;
    }
    // Mail parked while the eviction was in flight (or arriving between the
    // wakeable.set above and the evicting-map clear) is replayed by a wake.
    const parked = parkedMail.get(agentAddress);
    if (parked !== undefined && parked.length > 0) {
      void wakeAgent(agentAddress).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error`Wake after eviction for ${agentAddress} failed: ${msg}`;
        reportTerminalWakeFailure(agentAddress, err);
      });
    }
  }

  // WORKBENCH-LOCAL (CL-3340): the eviction teardown is shared by the idle
  // sweep and the assistant-loop interrupt; the reason is threaded through
  // for log attribution only.
  type EvictReason = "idle-evict" | "loop-interrupt";

  function evictSession(
    agentAddress: string,
    session: LiveSession,
    reason: EvictReason = "idle-evict",
  ): Promise<void> {
    const existing = evicting.get(agentAddress);
    if (existing !== undefined) return existing;
    const done = performEvict(agentAddress, session, reason).finally(() => {
      if (evicting.get(agentAddress) === done) evicting.delete(agentAddress);
    });
    evicting.set(agentAddress, done);
    return done;
  }

  function isEvictable(agentAddress: string, cutoff: number): boolean {
    // A turn (message run) in flight — including its tool execution, which
    // emits no inference events — must never be evicted.
    if ((activeRuns.get(agentAddress) ?? 0) > 0) return false;
    // An attached in-process event subscriber (e.g. a workflow reactor) is
    // an open consumer; leave the session resident.
    const listeners = agentEventListeners.get(agentAddress);
    if (listeners !== undefined && listeners.size > 0) return false;
    // Mail parked for this address is pending work.
    const parked = parkedMail.get(agentAddress);
    if (parked !== undefined && parked.length > 0) return false;
    // A wake/build in flight (defensive — a waking agent has no live session).
    if (waking.has(agentAddress)) return false;
    const last = lastActivityAt.get(agentAddress);
    // No recorded activity yet is treated as not-idle (fail safe).
    if (last === undefined) return false;
    return last <= cutoff;
  }

  async function evictIdleSessions(): Promise<void> {
    if (idleEvictMs <= 0) return;
    const cutoff = now() - idleEvictMs;
    const pendingEvicts: Promise<void>[] = [];
    for (const [agentAddress, session] of sessions) {
      if (evicting.has(agentAddress)) continue;
      if (!isEvictable(agentAddress, cutoff)) continue;
      pendingEvicts.push(evictSession(agentAddress, session));
    }
    await Promise.allSettled(pendingEvicts);
  }

  // WORKBENCH-LOCAL (CL-3339): user-initiated turn abort. Reuses the evict
  // teardown (harness close → reactor abort → durable flush → wakeable), so
  // stopping a turn is a sleep, not a kill: no `endedAt`, no deleteAgentDir,
  // and the very next message wakes the agent with full history. Before the
  // teardown, every open run is settled with a synthetic failed
  // `message.run.ended` (error kind `turn_aborted`) through the session's own
  // event pipeline, so the hub's turn projection shows an explained,
  // interrupted turn instead of a dangling bracket-open.
  async function abortTurn(agentAddress: string): Promise<void> {
    await awaitEviction(agentAddress);
    const session = sessions.get(agentAddress);
    if (session === undefined || (activeRuns.get(agentAddress) ?? 0) === 0) {
      throw new NoActiveTurnError(agentAddress);
    }
    const runs = openRuns.get(agentAddress);
    if (runs !== undefined) {
      let seq = lastEventSeq.get(agentAddress) ?? 0;
      for (const [messageRunId, messageId] of [...runs]) {
        seq += 1;
        try {
          session.emitEvent({
            type: "message.run.ended",
            seq,
            data: {
              messageRunId,
              messageId,
              status: "failed",
              error: { kind: "turn_aborted", message: "Stopped by user" },
            },
          });
        } catch (err: unknown) {
          // A throwing per-agent listener must not block the abort itself.
          logger.warn`Settling aborted run ${messageRunId} for ${agentAddress} threw: ${String(err)}`;
        }
      }
    }
    await evictSession(agentAddress, session);
    logger.info`Aborted running turn for ${agentAddress}`;
  }

  async function abortSession(
    agentAddress: string,
    reason: string,
  ): Promise<void> {
    // WORKBENCH-LOCAL (CL-3103): see destroySession — settle an in-flight
    // eviction before tearing down.
    await awaitEviction(agentAddress);
    if (provisioned.has(agentAddress)) {
      provisioned.delete(agentAddress);
      // WORKBENCH-LOCAL (CL-3102): also drop any lazy-restore state so
      // later mail cannot resurrect the destroyed agent.
      wakeable.delete(agentAddress);
      parkedMail.delete(agentAddress);
      logger.info`Aborted provisioned agent ${agentAddress}: ${reason}`;
      return;
    }
    // WORKBENCH-LOCAL (CL-3102): see destroySession — a never-woken agent
    // has only restore metadata to drop.
    if (wakeable.has(agentAddress)) {
      wakeable.delete(agentAddress);
      parkedMail.delete(agentAddress);
      logger.info`Aborted wakeable agent ${agentAddress}: ${reason}`;
      return;
    }
    const session = sessions.get(agentAddress);
    if (session === undefined) {
      throw new Error(`No session exists for agent "${agentAddress}"`);
    }
    await session.harness.close();
    const disposerErrors = await runDisposers(session, agentAddress);
    await drainRepoOps(agentAddress);
    sessions.delete(agentAddress);
    transport.unregister(agentAddress);
    // WORKBENCH-LOCAL (CL-3103): drop idle bookkeeping for the gone session.
    lastActivityAt.delete(agentAddress);
    activeRuns.delete(agentAddress);
    // WORKBENCH-LOCAL (CL-3339): and the turn-abort bookkeeping.
    openRuns.delete(agentAddress);
    lastEventSeq.delete(agentAddress);
    if (disposerErrors.length > 0) {
      logger.warn`Aborted agent ${agentAddress} (${reason}) with ${String(disposerErrors.length)} disposer failure(s)`;
    } else {
      logger.info`Aborted agent ${agentAddress}: ${reason}`;
    }
    reclaimHeap(`abort ${agentAddress}`);
  }

  function deliverMessage(agentAddress: string, message: InboundMessage): void {
    const session = sessions.get(agentAddress);
    if (session === undefined) {
      throw new Error(`No session exists for agent "${agentAddress}"`);
    }
    // WORKBENCH-LOCAL (CL-3103): a direct harness delivery is activity.
    markActivity(agentAddress);
    // WORKBENCH-LOCAL (CL-3340): a user message resets the loop run.
    assistantLoopGuard.reset(agentAddress);
    session.harness.deliver(message);
  }

  function hasSession(agentAddress: string): boolean {
    return sessions.has(agentAddress);
  }

  function isProvisioned(agentAddress: string): boolean {
    return provisioned.has(agentAddress);
  }

  function getAddresses(): string[] {
    return [...sessions.keys()];
  }

  // WORKBENCH-LOCAL (CL-3102): lazy restore. A sidecar reconnect must not
  // rebuild every agent's harness (a full tool-package materialization +
  // credential HTTP fetch each) — that is the idle-RAM cost, and the
  // boot-time fetch races the hub's endpoint during a co-deploy and leaves
  // agents silently toolless. Instead `restoreSessions` recovers only the
  // routing metadata: it warms the key cache (via `scanKeys`, needed for
  // challenge signing) and remembers each on-disk agent's config as
  // `wakeable` so the returned addresses can be advertised in the reconnect
  // frame and the hub keeps routing mail to them. The harness is built
  // lazily by `wakeAgent` on the first inbound message or explicit session
  // open. A config with no on-disk key pair is a hard failure — the agent's
  // identity cannot be recovered without it.
  //
  // Key-without-config does not appear here because AgentKeyStore's
  // scanKeys already requires a parseable agent.json before surfacing the
  // directory, so the orphan-key case is filtered at the store boundary.
  async function restoreSessions(): Promise<RestoreResult> {
    const [keysByAddress, configEntries] = await Promise.all([
      keyStore.scanKeys().then((k) => new Map(k.map((e) => [e.address, e]))),
      repoStore.scanConfigs(),
    ]);

    const restored: RestoredAgent[] = [];
    const failed: string[] = [];

    for (const entry of configEntries) {
      const keyEntry: AgentKeyEntry | undefined = keysByAddress.get(
        entry.address,
      );
      if (keyEntry === undefined) {
        logger.error`Cannot restore "${entry.address}": agent.json exists but key pair is missing`;
        failed.push(entry.address);
        continue;
      }

      const agent: RestoredAgent = {
        address: entry.address,
        keyPair: keyEntry.keyPair,
      };
      if (entry.hubPublicKey !== undefined) {
        agent.hubPublicKey = entry.hubPublicKey;
      }
      restored.push(agent);

      // An already-live session (e.g. an agent deployed during the restore
      // window) needs no wakeable entry — it is already built and routable.
      if (sessions.has(entry.address)) continue;

      wakeable.set(entry.address, {
        config: entry.config,
        keyPair: keyEntry.keyPair,
      });
      logger.info`Registered wakeable agent ${entry.address}`;
    }

    return { restored, failed };
  }

  // WORKBENCH-LOCAL (CL-3102): build a restored agent's harness on demand.
  // One attempt: promote the wakeable entry into `provisioned` and run the
  // normal `startSession`, which registers the transport and fetches
  // credentials at build time. `startSession`'s own failure path restores
  // the `provisioned` entry; we clear it so a failed attempt leaves the
  // agent purely wakeable for the next retry.
  //
  // Cancellation contract with destroySession/abortSession: teardown of a
  // not-yet-built agent removes its `wakeable` entry. The entry surviving
  // until build success is therefore the liveness token — if it is gone
  // when the build lands, the agent was destroyed mid-build, so the
  // freshly built harness is torn down instead of registered and the
  // wake rejects with WakeAbortedError (never retried).
  async function wakeAttempt(
    agentAddress: string,
    token: { superseded: boolean },
  ): Promise<void> {
    const entry = wakeable.get(agentAddress);
    if (entry === undefined || token.superseded) {
      throw new WakeAbortedError(
        `Wake aborted for "${agentAddress}": agent was destroyed or superseded`,
      );
    }
    // Snapshot the config the build will run against. An update landing
    // during the build rebinds `entry.config` (the entry object itself is
    // stable), so a changed reference after the build means the harness
    // came live against a stale config and the drift must be re-applied.
    const configAtBuild = entry.config;
    const wakeProvision: ProvisionedAgent = {
      config: configAtBuild,
      keyPair: entry.keyPair,
    };
    provisioned.set(agentAddress, wakeProvision);
    try {
      await startSessionCore(agentAddress);
    } catch (err) {
      // Delete only OUR entry (startSessionCore's guarded rollback put it
      // back on failure). A superseding provisionAgent's fresh entry that
      // landed during the failed build must survive, or the deploy's
      // session.start finds no provisioned agent.
      if (provisioned.get(agentAddress) === wakeProvision) {
        provisioned.delete(agentAddress);
      }
      throw err;
    }
    // Ownership: this is OUR build — startSessionCore just installed it,
    // and any competing startSessionCore would have thrown on the
    // sessions/transport collision. Captured so the abort branch below
    // can never tear down a session installed by someone else.
    const ourSession = sessions.get(agentAddress);
    if (token.superseded || wakeable.get(agentAddress) !== entry) {
      // Destroyed or superseded while the harness was building: discard
      // the zombie build (dispose the bundle, unregister the transport)
      // rather than leaving a live harness for a torn-down or replaced
      // agent — but only the session WE built, via the session-only
      // teardown (destroySession's provisioned/wakeable early branches
      // may now belong to the superseding deploy).
      if (
        ourSession !== undefined &&
        sessions.get(agentAddress) === ourSession
      ) {
        await destroyLiveSession(agentAddress, ourSession, "wake-abort");
      }
      throw new WakeAbortedError(
        `Wake aborted for "${agentAddress}": agent was destroyed or superseded during the build`,
      );
    }
    if (entry.config !== configAtBuild && ourSession !== undefined) {
      // An updateGrants/updateSources landed during the build: the
      // harness came live against the snapshot, so re-apply the current
      // config to the live session (the update path already persisted
      // it to disk).
      ourSession.bundle.updateGrants(entry.config.grants);
      ourSession.harness.setSources(
        entry.config.sources,
        entry.config.defaultSource,
      );
      ourSession.config = entry.config;
      logger.info`Re-applied config updated during wake for ${agentAddress}`;
    }
    wakeable.delete(agentAddress);
  }

  // WORKBENCH-LOCAL (CL-3102): retry the build with bounded exponential
  // backoff. The dominant failure is the hub's credential endpoint being
  // briefly unreachable during a co-deploy; retrying rather than caching a
  // credential-less harness means a wake is never permanently degraded.
  // The wake clock starts at the trigger (message received) so the logged
  // duration measures received → harness ready.
  // Attempt-boundary waiters: callers on a wire deadline
  // (`awaitFirstAttemptOnly`) register here — whether they started the
  // wake or joined one mid-retry — and are settled with the outcome of
  // the NEXT attempt to complete, never the full retry schedule.
  type AttemptWaiter = { resolve(): void; reject(err: unknown): void };
  const attemptWaiters = new Map<string, Set<AttemptWaiter>>();

  function registerAttemptWaiter(agentAddress: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let set = attemptWaiters.get(agentAddress);
      if (set === undefined) {
        set = new Set();
        attemptWaiters.set(agentAddress, set);
      }
      set.add({ resolve, reject });
    });
  }

  function settleAttemptWaiters(agentAddress: string, err?: unknown): void {
    const set = attemptWaiters.get(agentAddress);
    if (set === undefined) return;
    attemptWaiters.delete(agentAddress);
    for (const waiter of set) {
      if (err === undefined) waiter.resolve();
      else waiter.reject(err);
    }
  }

  async function performWake(
    agentAddress: string,
    startedAt: number,
    token: { superseded: boolean },
  ): Promise<void> {
    let attempt = 0;
    try {
      for (;;) {
        attempt += 1;
        try {
          await wakeAttempt(agentAddress, token);
          const elapsedMs = Date.now() - startedAt;
          logger.info`Woke agent ${agentAddress} in ${String(elapsedMs)}ms (attempt ${String(attempt)})`;
          // Clear the in-flight marker and drain in the same synchronous
          // region: nothing can park a message between them, so mail
          // parked during the build is always replayed regardless of
          // which caller (inbound mail or session.start) triggered the
          // wake, and mail arriving after the drain delivers live.
          waking.delete(agentAddress);
          drainParkedMail(agentAddress);
          settleAttemptWaiters(agentAddress);
          return;
        } catch (err) {
          // Every attempt boundary settles the registered waiters with
          // that attempt's outcome; waiters registered during the backoff
          // sleep are settled by the next boundary.
          settleAttemptWaiters(agentAddress, err);
          if (err instanceof WakeAbortedError) {
            logger.info`${err.message}`;
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt >= wakeMaxAttempts) {
            logger.error`Wake failed for ${agentAddress} after ${String(attempt)} attempt(s): ${msg}`;
            throw err instanceof Error ? err : new Error(msg);
          }
          const delayMs = Math.min(
            wakeBaseDelayMs * 2 ** (attempt - 1),
            wakeMaxDelayMs,
          );
          logger.warn`Wake attempt ${String(attempt)} for ${agentAddress} failed: ${msg}; retrying in ${String(delayMs)}ms`;
          await sleep(delayMs);
        }
      }
    } finally {
      waking.delete(agentAddress);
      if (wakeTokens.get(agentAddress) === token) {
        wakeTokens.delete(agentAddress);
      }
      // Safety net: a waiter registered after the terminal attempt's
      // settle (same wake — waking is cleared synchronously with each
      // settle, so this is normally empty) must not hang forever.
      settleAttemptWaiters(
        agentAddress,
        new WakeAbortedError(
          `Wake for "${agentAddress}" ended before the awaited attempt`,
        ),
      );
    }
  }

  function wakeAgent(
    agentAddress: string,
    opts?: { awaitFirstAttemptOnly?: boolean },
  ): Promise<void> {
    if (sessions.has(agentAddress)) return Promise.resolve();
    const awaitFirstAttemptOnly = opts?.awaitFirstAttemptOnly === true;
    const inflight = waking.get(agentAddress);
    if (inflight !== undefined) {
      // A deadline-bound caller joining a wake mid-retry awaits only the
      // next attempt boundary, not the remainder of the retry schedule.
      if (awaitFirstAttemptOnly) return registerAttemptWaiter(agentAddress);
      return inflight;
    }
    // Fast-fail an unknown address: retrying cannot make a missing
    // wakeable entry appear.
    if (!wakeable.has(agentAddress)) {
      return Promise.reject(
        new Error(`No wakeable agent for address "${agentAddress}"`),
      );
    }
    const startedAt = Date.now();
    const token = { superseded: false };
    wakeTokens.set(agentAddress, token);
    // performWake owns removing the `waking` entry (in its own success /
    // failure paths) so the removal is synchronous with the parked-mail
    // drain; a `.finally` here would run one microtask later and could
    // clobber a newer wake's entry.
    const build = performWake(agentAddress, startedAt, token);
    waking.set(agentAddress, build);
    if (awaitFirstAttemptOnly) {
      // The caller observes only the first attempt boundary; the full
      // build's eventual rejection (retries exhausted / aborted) is
      // already logged by performWake — observe it so it cannot surface
      // as an unhandled rejection.
      build.catch(() => undefined);
      return registerAttemptWaiter(agentAddress);
    }
    return build;
  }

  function isWakeable(agentAddress: string): boolean {
    return wakeable.has(agentAddress);
  }

  // WORKBENCH-LOCAL (CL-3102): deliver a raw inbound mail message to a live
  // session's mailbox and enqueue the audit commit. Transport delivery
  // errors are logged (not thrown) so a malformed frame never wedges the
  // caller; the commit is enqueued only for a live session so it cannot
  // reject unobserved.
  function deliverLive(agentAddress: string, rawMessage: Uint8Array): void {
    // WORKBENCH-LOCAL (CL-3340): a user message resets the loop run.
    assistantLoopGuard.reset(agentAddress);
    try {
      transport.deliver(agentAddress, rawMessage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`Failed to deliver inbound mail to ${agentAddress}: ${msg}`;
    }
    if (sessions.has(agentAddress)) {
      // WORKBENCH-LOCAL (CL-3103): inbound mail is activity.
      markActivity(agentAddress);
      void commitInboundMail(agentAddress, rawMessage);
    }
  }

  function parkMail(agentAddress: string, rawMessage: Uint8Array): void {
    let queue = parkedMail.get(agentAddress);
    if (queue === undefined) {
      queue = [];
      parkedMail.set(agentAddress, queue);
    }
    if (queue.length >= maxParkedMail) {
      logger.warn`Parked inbound mail queue full for ${agentAddress}, dropping oldest`;
      queue.shift();
    }
    queue.push(rawMessage);
  }

  // Replay parked messages into the freshly built harness in arrival
  // order. Synchronous with no await between deliveries, so a message
  // arriving concurrently cannot interleave ahead of the drained batch.
  function drainParkedMail(agentAddress: string): void {
    const queue = parkedMail.get(agentAddress);
    parkedMail.delete(agentAddress);
    if (queue === undefined) return;
    for (const rawMessage of queue) {
      deliverLive(agentAddress, rawMessage);
    }
  }

  function deliverInboundMail(
    agentAddress: string,
    rawMessage: Uint8Array,
  ): void {
    // A build already in flight: park behind the messages already queued so
    // arrival order is preserved when the batch drains.
    if (waking.has(agentAddress)) {
      parkMail(agentAddress, rawMessage);
      return;
    }
    // WORKBENCH-LOCAL (CL-3103): mail arriving mid-eviction must not deliver
    // into the harness being torn down. Park it; `performEvict` triggers a
    // wake that replays the parked batch once the old harness has flushed
    // and disposed.
    if (evicting.has(agentAddress)) {
      parkMail(agentAddress, rawMessage);
      return;
    }
    if (sessions.has(agentAddress)) {
      deliverLive(agentAddress, rawMessage);
      return;
    }
    if (wakeable.has(agentAddress)) {
      parkMail(agentAddress, rawMessage);
      // The wake itself drains the parked batch on success (performWake),
      // so a wake triggered by any caller replays this message.
      void wakeAgent(agentAddress).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Leave the parked batch in place: the agent stays wakeable, so
        // a later inbound message triggers a fresh wake that drains it.
        logger.error`Wake for inbound mail to ${agentAddress} failed: ${msg}`;
        reportTerminalWakeFailure(agentAddress, err);
      });
      return;
    }
    // Unknown address: fall through to the live path so the "no mailbox"
    // failure surfaces the same way it did before lazy restore.
    deliverLive(agentAddress, rawMessage);
  }

  async function updateGrants(
    agentAddress: string,
    grants: GrantRule[],
  ): Promise<void> {
    const session = sessions.get(agentAddress);
    if (session === undefined) {
      // WORKBENCH-LOCAL (CL-3102): a sleeping (wakeable) agent has no
      // harness to update, but the change must not be lost — fold it into
      // the stored config and persist so the eventual wake builds with the
      // fresh grants. No wake is forced; a config update is not activity.
      const entry = wakeable.get(agentAddress);
      if (entry !== undefined) {
        entry.config = { ...entry.config, grants };
        await repoStore.persistConfig(agentAddress, entry.config);
        logger.info`Updated grants for sleeping agent ${agentAddress} (${String(grants.length)} rules)`;
        return;
      }
      throw new Error(`No session exists for agent "${agentAddress}"`);
    }
    session.bundle.updateGrants(grants);
    session.config = { ...session.config, grants };
    await repoStore.persistConfig(agentAddress, session.config);
    logger.info`Updated grants for ${agentAddress} (${String(grants.length)} rules)`;
  }

  async function updateSources(
    agentAddress: string,
    sources: InferenceSource[],
    defaultSource: string,
  ): Promise<void> {
    const session = sessions.get(agentAddress);
    const source = sources.find((s) => s.id === defaultSource);
    if (source === undefined) {
      throw new Error(
        `No source matches defaultSource "${defaultSource}" in update for agent "${agentAddress}"`,
      );
    }
    buildHarness.canBuildSource(source);
    if (session === undefined) {
      // WORKBENCH-LOCAL (CL-3102): see updateGrants — persist the update
      // into the sleeping agent's stored config so the eventual wake
      // builds against the fresh sources.
      const entry = wakeable.get(agentAddress);
      if (entry !== undefined) {
        entry.config = { ...entry.config, sources, defaultSource };
        await repoStore.persistConfig(agentAddress, entry.config);
        logger.info`Updated sources for sleeping agent ${agentAddress}`;
        return;
      }
      throw new Error(`No session exists for agent "${agentAddress}"`);
    }
    session.harness.setSources(sources, defaultSource);
    session.config = { ...session.config, sources, defaultSource };
    await repoStore.persistConfig(agentAddress, session.config);
    logger.info`Updated sources for ${agentAddress}`;
  }

  async function applyDeployPack(
    agentAddress: string,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
    transferId: string,
    verifyCommit?: (payload: string, signature: string) => Promise<boolean>,
  ): Promise<void> {
    const args =
      verifyCommit !== undefined
        ? {
            address: agentAddress,
            pack,
            ref,
            commitSha,
            transferId,
            verifyCommit,
          }
        : { address: agentAddress, pack, ref, commitSha, transferId };
    await runRepoOp(agentAddress, () => repoStore.applyDeployPack(args));
  }

  async function applyAssetPack(
    agentAddress: string,
    mountPath: string,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
  ): Promise<void> {
    const workspaceRoot = path.join(
      repoStore.getAgentDir(agentAddress),
      "workspace",
    );
    await runRepoOp(agentAddress, () =>
      applyAssetPackFn({
        workspaceRoot,
        mountPath,
        pack,
        ref,
        commitSha,
      }),
    );
  }

  async function createStatePack(
    agentAddress: string,
  ): Promise<{ pack: Uint8Array; commitSha: string; ref: string }> {
    return runRepoOp(agentAddress, () =>
      repoStore.createStatePack(agentAddress),
    );
  }

  async function deleteAgentDir(agentAddress: string): Promise<void> {
    await drainRepoOps(agentAddress);
    await repoStore.remove(agentAddress);
  }

  async function persistHubPublicKey(
    agentAddress: string,
    hubPublicKey: string,
  ): Promise<void> {
    await repoStore.persistPairing(agentAddress, hubPublicKey);
  }

  async function commitInboundMail(
    agentAddress: string,
    rawMessage: Uint8Array,
  ): Promise<void> {
    const session = sessions.get(agentAddress);
    if (session === undefined) {
      throw new Error(
        `No active session for "${agentAddress}" — cannot audit inbound mail`,
      );
    }
    const mailStore = session.bundle.mailStore;
    enqueueMailCommit(agentAddress, async () => {
      const result = await mailStore.commitMail(rawMessage, "in", {
        ignoreDuplicate: true,
      });
      if (result !== null) {
        logger.info`Committed inbound mail ${result.messageId} for ${agentAddress}`;
      }
    });
  }

  function getSessionId(agentAddress: string): string | undefined {
    return sessions.get(agentAddress)?.config.sessionId;
  }

  async function getDeployRef(agentAddress: string): Promise<string | null> {
    return runRepoOp(agentAddress, () => repoStore.getDeployRef(agentAddress));
  }

  return {
    provisionAgent,
    startSession,
    wakeAgent,
    isWakeable,
    evictIdleSessions,
    deliverInboundMail,
    destroySession,
    abortSession,
    abortTurn,
    deliverMessage,
    updateGrants,
    onAgentEvent,
    updateSources,
    hasSession,
    isProvisioned,
    getAddresses,
    restoreSessions,
    applyDeployPack,
    applyAssetPack,
    createStatePack,
    deleteAgentDir,
    getDeployRef,
    persistHubPublicKey,
    commitInboundMail,
    getSessionId,
  };
}
