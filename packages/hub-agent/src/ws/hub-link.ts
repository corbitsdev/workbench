// HubLink: the sidecar-side WebSocket protocol.
//
// Connects to the hub, sends the register frame, forwards outbound
// mail and inference events, and handles inbound agent lifecycle
// commands. Per-agent key material lives on AgentKeyStore;
// the link calls into the store for challenge signing, deploy-commit
// verification, and hub-key bookkeeping. The wire layer itself never
// touches raw key bytes.

import { getLogger } from "@intx/log";
import type { HubTransport } from "@intx/mail-memory";
import { type } from "arktype";
import {
  HubFrame,
  type SidecarFrame,
  type AgentDeployFrame,
  type AgentErrorFrame,
  type SessionErrorFrame,
  type AgentUndeployFrame,
  type ChallengeFrame,
  type ChallengeFailedFrame,
  type PackPushFrame,
  type PackDoneFrame,
  type PackAckFrame,
  type PackRejectFrame,
  RepoId,
  type SignalDeliverFrame,
  type SignalCorrelationRegisterFrame,
  type DrainDeliverFrame,
  type SourcesUpdateFrame,
  type SyncRequestFrame,
} from "@intx/types/sidecar";
import type { SignalKind } from "@intx/types";
import { createPackReceiver, createPackSender } from "@intx/pack-transport";
import { base64Decode, base64Encode, hexDecode, hexEncode } from "@intx/types";
import type { InferenceEvent } from "@intx/types/runtime";

import type { AgentKeyStore } from "../agent-key-store";
import type { SessionManager } from "../session-manager";

/**
 * Sink the link exposes for forwarding a spawned child's verified
 * InferenceEvents to the hub timeline, keyed by the deploy's session id.
 */
export type SessionEventSink = (
  agentAddress: string,
  sessionId: string,
  event: InferenceEvent,
) => void;

const logger = getLogger(["interchange", "hub-agent", "ws"]);

/**
 * Permissive envelope over a raw inbound frame that failed `HubFrame`
 * validation. A malformed request/ack frame usually still carries an
 * intact discriminator and correlation key -- the malformation is in a
 * nested field -- so these top-level fields can be recovered to answer the
 * requester.
 */
const MalformedRequestEnvelope = type({
  "type?": "string",
  "requestId?": "string",
  "agentAddress?": "string",
  "transferId?": "string",
  // `repoId` is carried as `unknown` and validated only inside the pack
  // branch below. Validating it here would fail the whole envelope for a
  // non-pack frame that happens to carry a malformed `repoId`-shaped field,
  // sinking its recovery through its own correlation key.
  "repoId?": "unknown",
});

/**
 * Inbound request/ack frames the sidecar dispatches that the hub
 * correlates by `requestId`, whose failure reply is a `session.error`.
 * Only `sources.update` qualifies -- it is the sole frame answered with a
 * `session.error`. Frames answered through the other correlation keys live
 * in `AGENT_ERROR_REQUEST_TYPES` and `PACK_REJECT_REQUEST_TYPES`; a
 * request-shaped frame in none of the three sets has no requester to
 * answer and is dropped.
 */
const SESSION_ERROR_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "sources.update",
]);

/**
 * Inbound request/ack frames the hub correlates by `agentAddress` and
 * whose failure reply is an `agent.error` -- the frames the hub tracks in
 * its per-address pending-deploy / pending-undeploy maps.
 */
const AGENT_ERROR_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "agent.deploy",
  "agent.undeploy",
]);

/**
 * Inbound chunked-pack request frames the hub correlates by `transferId`
 * and whose failure reply is a `repo.pack.reject`. The hub tracks these in
 * its per-transfer pending map with the longest timeout of any request
 * frame.
 */
const PACK_REJECT_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "repo.pack.push",
  "repo.pack.done",
]);

/**
 * Answer a malformed inbound request/ack control frame with an error reply
 * so the hub's request does not hang to its timeout. Two control-frame
 * families answer through their correlation key: the `requestId`-correlated
 * frame (sources.update) replies `session.error`; the
 * `agentAddress`-correlated frames (agent.deploy, agent.undeploy) reply
 * `agent.error`. The fire-and-forget frames
 * (mail/signal/drain/...) have no requester waiting on a reply, so a
 * malformed one is correctly left to be logged and dropped by the caller.
 *
 * The chunked `repo.pack` streaming transfers (repo.pack.push,
 * repo.pack.done) are the third family: correlated by `transferId`,
 * rejected by `repo.pack.reject`. A valid reject also carries the frame's
 * `agentAddress` and structured `repoId`, so it is answerable only when
 * all three survive the malformation; when `repoId` (or the transferId) is
 * itself unrecoverable the frame is left to be logged and dropped, because
 * a valid `repo.pack.reject` cannot be constructed without them.
 *
 * Returns `true` when it answered; `false` when no correlation key is
 * recoverable (an unknown/absent type, a fire-and-forget frame, or a
 * request/ack frame whose key is itself missing) -- the caller then logs
 * and drops, because there is nothing to answer.
 */
export function answerMalformedRequestFrame(
  raw: unknown,
  summary: string,
  send: (frame: SessionErrorFrame | AgentErrorFrame | PackRejectFrame) => void,
): boolean {
  const envelope = MalformedRequestEnvelope(raw);
  if (envelope instanceof type.errors) return false;
  const frameType = envelope.type;
  if (frameType === undefined) return false;
  if (
    SESSION_ERROR_REQUEST_TYPES.has(frameType) &&
    envelope.requestId !== undefined &&
    envelope.requestId.length > 0
  ) {
    send({
      type: "session.error",
      requestId: envelope.requestId,
      error: `malformed ${frameType} frame: ${summary}`,
    });
    return true;
  }
  if (
    AGENT_ERROR_REQUEST_TYPES.has(frameType) &&
    envelope.agentAddress !== undefined &&
    envelope.agentAddress.length > 0
  ) {
    send({
      type: "agent.error",
      agentAddress: envelope.agentAddress,
      error: `malformed ${frameType} frame: ${summary}`,
    });
    return true;
  }
  if (
    PACK_REJECT_REQUEST_TYPES.has(frameType) &&
    envelope.transferId !== undefined &&
    envelope.transferId.length > 0 &&
    envelope.agentAddress !== undefined &&
    envelope.agentAddress.length > 0
  ) {
    // A valid repo.pack.reject carries the frame's structured repoId, so
    // recover it here (kept out of the shared envelope to protect the other
    // families). When the repoId is itself malformed there is no valid
    // reject to build, so the frame is left to be dropped. The hub
    // correlates the reject by transferId alone; "corrupt" is the reason
    // for a frame that failed to parse.
    const repoId = RepoId(envelope.repoId);
    if (repoId instanceof type.errors) return false;
    send({
      type: "repo.pack.reject",
      agentAddress: envelope.agentAddress,
      repoId,
      transferId: envelope.transferId,
      reason: "corrupt",
    });
    return true;
  }
  return false;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
// WORKBENCH-LOCAL (CL-2405): exponential reconnect backoff with jitter,
// sustained-failure WARN escalation, and a configurable outbound queue —
// upstream uses a fixed 3s delay and a fixed 1024-frame queue.
// Initial/floor reconnect delay. Kept short so a brief hub absence (a
// Railway redeploy window) reconnects near-instantly rather than idling
// a fixed multi-second delay.
const DEFAULT_RECONNECT_DELAY_MS = 300;
// Cap for the exponential backoff. Deliberately low: the goal is to
// reconnect quickly once the hub returns, so a backed-off link never
// idles for many seconds. Backoff only avoids a tight hammer loop while
// the hub stays down.
const DEFAULT_MAX_RECONNECT_DELAY_MS = 3_000;
// After the link has been unable to reach the hub continuously for this
// long, escalate from debug retry breadcrumbs to a single WARN so a real
// outage stays visible without every expected redeploy blip reading as
// an incident.
const SUSTAINED_FAILURE_WARN_MS = 30_000;
const DEFAULT_MAX_OUTBOUND_QUEUE = 4096;
// WORKBENCH-LOCAL (CL-3826): per-attempt connect timeout. Railway's redeploy
// overlap window can route internal DNS to a draining replica whose TCP
// connect blackholes rather than refusing; without a bound the reconnect
// loop stalls for the entire overlap window instead of retrying on the fast
// backoff above. Kept close to the reconnect defaults it works alongside.
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The reason string `packSender.cancelAll` rejects an in-flight transfer with
 * when the link cycles on the reconnect `open` handler. A push that fails with
 * this is a dropped connection, not a receiver-side rejection, so the
 * workflow-run push path must not fast-retry it (see `runWithBootstrap`); the
 * pushing store's post-challenge re-drive owns reconnect recovery.
 */
const CONNECTION_LOST_REASON = "Connection lost";

function isConnectionLost(err: unknown): boolean {
  return err instanceof Error && err.message === CONNECTION_LOST_REASON;
}

/**
 * Schedules a deferred callback and returns a cancel function. Injection
 * point for tests: a fake scheduler records the callback so the test
 * can observe whether cancellation actually happened, without relying
 * on wall-clock waits.
 */
export type ReconnectScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

const defaultScheduleReconnect: ReconnectScheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Result the deploy router returns to the link once a deploy has
 * staged. Carries the values the link folds into the outbound
 * `agent.deploy.ack` frame; the link itself stays out of the deploy
 * details.
 */
export type DeployRouterResult = {
  /** Hex-encoded agent public key the hub records for verification. */
  publicKey: string;
};

/**
 * Single-ingress deploy contract the link routes every `agent.deploy`
 * frame through. The sidecar's workflow-run deploy router is the
 * production implementation -- it stages every deploy through the
 * workflow-run substrate. The shape lives on hub-agent so the package
 * boundary stays one-way (`@intx/hub-agent` does not import
 * `@intx/workflow-host`).
 */
export interface DeployRouter {
  deploy(frame: AgentDeployFrame): Promise<DeployRouterResult>;
  /**
   * Symmetric teardown for `deploy`. The link invokes this when an
   * `agent.undeploy` frame lands so the router can release any
   * per-deployment registrations the deploy path installed
   * (`MultistepMailRouter`, `MultistepSignalRouter`,
   * `MultistepDrainRouter`, `DeploymentAddressRegistry`). Optional
   * so test routers can omit the implementation.
   */
  undeploy?: (frame: AgentUndeployFrame) => Promise<void>;
  /**
   * WORKBENCH-LOCAL (CL-3104): state-PRESERVING teardown for `deploy`.
   * The link invokes this instead of `undeploy` when an `agent.undeploy`
   * frame carries the `WORKFLOW_HIBERNATE_UNDEPLOY_REASON` marker: the
   * router must release the same per-deployment routing state and shut
   * the supervisor/child down, but keep every durable on-disk artifact
   * (workflow-run repo, per-step agent-state repos, step scratch) so a
   * later re-deploy at the same address resumes the parked run from the
   * durable log. Optional for routers that never host workflows.
   */
  hibernate?: (frame: AgentUndeployFrame) => Promise<void>;
}

/**
 * WORKBENCH-LOCAL (CL-3104): well-known `agent.undeploy` reason the hub's
 * workflow reconciler sends to hibernate a gate-parked (awaiting) run's
 * deployment. The undeploy frame (`@intx/types/sidecar`) carries only
 * `{ agentAddress, reason }` and the hub-side sender (`@workbench/hub-sessions`
 * `sendAgentUndeploy`) exposes only those two fields, so the hibernate
 * flavor rides the reason string — the one hub→sidecar teardown seam that
 * crosses interchange unmodified.
 *
 * PROTOCOL CONSTANT: `apps/hub/src/services/workflow-reconciler.ts`
 * carries a byte-identical copy (the hub does not depend on this package).
 * Change both together or hibernate silently degrades on one side.
 */
export const WORKFLOW_HIBERNATE_UNDEPLOY_REASON =
  "workbench:hibernate-awaiting-run";

/**
 * Per-address mail handler registry the link consults on every
 * `mail.inbound` frame. Production wires this against the sidecar's
 * `createMultistepMailRouter` so a supervised deployment's supervisor
 * receives the bytes through its mail-bus subscription. Mail for an
 * address with no registered handler has no receiver and is dropped.
 * The shape lives on hub-agent so the link does not import the sidecar
 * host's wiring module, and so tests can substitute a stub.
 */
export interface MailInboundRouter {
  /**
   * Attempt to dispatch `message` to a handler registered against
   * `agentAddress`. Returns `true` if a handler claimed the message;
   * `false` if no handler is registered, in which case the link logs
   * and drops the mail.
   */
  tryRoute(agentAddress: string, message: Uint8Array): boolean;
}

/**
 * Per-deployment-address signal handler registry the link consults on
 * every inbound `signal.deliver` frame. Production wires this against
 * the sidecar's multi-step deploy registry so the frame flows into the
 * deployment's supervisor (which forwards `signal.deliver` over the
 * control IPC to the workflow-process child). The link logs and drops
 * a frame whose `agentAddress` matches no registered handler so the
 * wire surface fails loudly rather than silently absorbing a misrouted
 * delivery.
 *
 * The shape lives on hub-agent so the link does not import the sidecar
 * host's wiring module, and so tests can substitute a stub.
 */
export interface SignalInboundRouter {
  /**
   * Attempt to dispatch `frame` to the supervisor registered against
   * `frame.agentAddress`. Returns a promise that resolves to `true`
   * when a handler accepted the frame, `false` when no handler is
   * registered; the promise rejects when the handler is registered but
   * the supervisor's `deliverSignal` itself throws. The link surfaces
   * a rejection through a logged warning -- a structured failure-reply
   * frame for signals does not exist on the wire today.
   */
  tryRoute(frame: SignalDeliverFrame): Promise<boolean>;
}

/**
 * Per-deployment-address drain handler registry the link consults on
 * every inbound `drain.deliver` frame. Production wires this against
 * the sidecar's multi-step deploy registry so the frame flows into the
 * deployment's supervisor (which forwards a `drain` control IPC frame
 * to the workflow-process child and arms one drainTimeout accumulator
 * per in-flight run). The link logs and drops a frame whose
 * `agentAddress` matches no registered handler so the wire surface
 * fails loudly rather than silently absorbing a misrouted delivery.
 *
 * The shape lives on hub-agent so the link does not import the sidecar
 * host's wiring module, and so tests can substitute a stub.
 */
export interface DrainInboundRouter {
  /**
   * Attempt to dispatch `frame` to the supervisor registered against
   * `frame.agentAddress`. Returns a promise that resolves to `true`
   * when a handler accepted the frame, `false` when no handler is
   * registered; the promise rejects when the handler is registered but
   * the supervisor's `drain` itself throws. The link surfaces a
   * rejection through a logged warning -- a structured failure-reply
   * frame for drain does not exist on the wire today.
   */
  tryRoute(frame: DrainDeliverFrame): Promise<boolean>;
}

/**
 * Per-deployment-address sources-rotation registry the link consults on
 * every inbound `sources.update` frame. Unlike signal/drain, `sources.update`
 * is a REQUEST/ACK frame, so the link answers `session.ack` / `session.error`
 * rather than logging and dropping -- a missing answer hangs the hub's
 * request for its full timeout.
 *
 * The shape lives on hub-agent so the link does not import the sidecar
 * host's wiring module, and so tests can substitute a stub.
 */
export interface SourcesInboundRouter {
  /**
   * Attempt to dispatch `frame` to the supervisor registered against
   * `frame.agentAddress`. Resolves `true` when a handler accepted the
   * rotation, `false` when no handler is registered (an unrouted address).
   * Rejects when the handler is registered but the rotation is invalid or
   * the supervisor's `deliverSources` throws; the link turns a rejection
   * into a `session.error` carrying the reason.
   */
  tryRoute(frame: SourcesUpdateFrame): Promise<boolean>;
}

export type HubLinkConfig = {
  hubURL: string;
  sidecarId: string;
  token: string;
  transport: HubTransport;
  sessions: SessionManager;
  /**
   * Key custody and per-frame crypto. HubLink calls into the store for
   * challenge signing, deploy-commit verification, hub-key recording,
   * and per-agent forgetting; it does not maintain its own copy of
   * those tables.
   */
  keyStore: AgentKeyStore;
  /**
   * Routes every inbound `agent.deploy` frame. Production wiring
   * supplies a router that stages each deploy through the workflow-run
   * substrate: a provision-step frame primes a per-step repo, and a
   * workflow frame spawns the supervised workflow-process child. The
   * router owns the routing decision; the link does not re-decide.
   */
  deployRouter: DeployRouter;
  /**
   * Optional inbound mail dispatcher. When present, the link consults
   * this router on every inbound `mail.inbound` frame. Production wires
   * this against the sidecar's multi-step deploy registry so a
   * deployment-address inbound flows into the supervisor's mail-bus
   * subscription. Absent (or a `false` return) means no handler claims
   * the mail, so the link logs and drops it.
   */
  mailInboundRouter?: MailInboundRouter;
  /**
   * Optional inbound signal dispatcher. When present, the link routes
   * every inbound `signal.deliver` frame through this router. Production
   * wires this against the sidecar's multi-step deploy registry so a
   * deployment-address signal flows into the supervisor's
   * `deliverSignal`. Absent (or a `false` return) causes inbound signal
   * frames to be logged-and-dropped so a misrouted delivery is
   * observable rather than silent.
   */
  signalInboundRouter?: SignalInboundRouter;
  /**
   * Optional inbound drain dispatcher. When present, the link routes
   * every inbound `drain.deliver` frame through this router. Production
   * wires this against the sidecar's multi-step deploy registry so a
   * deployment-address drain flows into the supervisor's `drain`. Absent
   * (or a `false` return) causes inbound drain frames to be
   * logged-and-dropped so a misrouted delivery is observable rather than
   * silent.
   */
  drainInboundRouter?: DrainInboundRouter;
  /**
   * Optional inbound sources-rotation dispatcher. When present, the link
   * routes every inbound `sources.update` frame through this router and
   * answers the request/ack frame: `session.ack` when the router accepted
   * the rotation, `session.error` when no deployment is registered, when
   * the rotation is invalid, or when delivery throws. Absent means the
   * link answers `session.error` for every rotation -- required because a
   * request/ack frame with no reply hangs the hub's request.
   */
  sourcesInboundRouter?: SourcesInboundRouter;
  /**
   * Returns the workflow-substrate deployment addresses this sidecar
   * currently hosts a live supervisor for. Called on every (re)connect to
   * announce them to the hub for routing through the CHALLENGED reconnect
   * frame: each deployment carries its own Ed25519 key (minted at deploy,
   * acked to the hub), so it proves ownership via challenge/response exactly
   * like a launched agent -- there is no keyless routing shortcut. Without
   * this announcement the hub drops the deployment's route on a WS reconnect.
   * Defaults to none when omitted (tests / deployments with no workflow
   * substrate).
   */
  getWorkflowAddresses?: () => string[];
  /**
   * Invoked once per reconnect ownership challenge with the addresses this
   * link just signed a `challenge.response` for. The workflow-run pack pusher
   * subscribes so it can re-drive a push that a disconnect cancelled -- gated
   * on this signal so the re-ship cannot race ahead of the address becoming
   * routable again. Absent when omitted (tests / deployments with no
   * workflow-run pack pipeline).
   */
  onWorkflowAddressesRoutable?: (addresses: string[]) => void;
  /**
   * Invoked on WS disconnect with the workflow-substrate addresses this link
   * hosts (`getWorkflowAddresses()`). Their hub route is gone until the next
   * reconnect challenge re-proves ownership, so the workflow-run pack pusher
   * blocks their pushes in the interim. Paired with
   * `onWorkflowAddressesRoutable`, which lifts the block once the challenge
   * passes. Absent when omitted.
   */
  onWorkflowAddressesUnroutable?: (addresses: string[]) => void;
  pingIntervalMs?: number;
  // WORKBENCH-LOCAL (CL-2405): backoff/queue tuning options.
  /** Initial/floor reconnect delay; backoff grows from here (default 300ms). */
  reconnectDelayMs?: number;
  /** Upper bound the exponential backoff is clamped to (default 3000ms). */
  maxReconnectDelayMs?: number;
  /** Max outbound frames queued while disconnected (default 4096). */
  maxOutboundQueue?: number;
  scheduleReconnect?: ReconnectScheduler;
  // WORKBENCH-LOCAL (CL-3826): per-attempt connect timeout tuning.
  /**
   * Per-attempt cap on how long a connect attempt may wait for the `open`
   * event before it is abandoned (default 5000ms). Guards against a TCP
   * connect that blackholes (e.g. Railway routing to a draining replica
   * during a redeploy overlap window) rather than refusing outright.
   */
  connectTimeoutMs?: number;
  /** Injection point for tests; same shape as `scheduleReconnect`. */
  scheduleConnectTimeout?: ReconnectScheduler;
};

export type HubLink = {
  /**
   * Open the connection. Must not be called after `close()`; calling it
   * on a closed client throws.
   */
  connect(): void;
  close(): void;
  sendEvent: SessionEventSink;
  /**
   * Register a control-plane suspension with the hub. Sends a
   * `signal.correlation.register` frame so the hub co-writes the parked run's
   * routing + approval rows. Fired by the sidecar's supervisor when a workflow
   * agent step parks on a reserved correlation channel; the fields converge at
   * this seam (`correlationId`/`runId`/`kind` from the child, `deploymentId`/
   * `agentAddress` stamped by the supervisor). Mirrors `sendEvent`: a
   * fire-and-forget hub-bound send that queues while disconnected.
   */
  sendSignalCorrelationRegister: (registration: {
    correlationId: string;
    runId: string;
    deploymentId: string;
    agentAddress: string;
    kind: SignalKind;
  }) => void;
  /**
   * Ship a workflow-run pack to the hub. Streams the supplied pack as
   * `repo.pack.push` chunks followed by a `repo.pack.done`, then
   * resolves on the matching `repo.pack.ack` (rejects on
   * `repo.pack.reject` with the carried reason). The hub routes the
   * pack to its `workflow-run` receiver because `repoId.kind` is
   * `"workflow-run"`.
   */
  pushWorkflowRunPack: (opts: {
    agentAddress: string;
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
  }) => Promise<void>;
};

export function createHubLink(config: HubLinkConfig): HubLink {
  const {
    hubURL,
    sidecarId,
    token,
    transport,
    sessions,
    keyStore,
    deployRouter,
    mailInboundRouter,
    signalInboundRouter,
    drainInboundRouter,
    sourcesInboundRouter,
    getWorkflowAddresses = () => [],
    onWorkflowAddressesRoutable,
    onWorkflowAddressesUnroutable,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
    maxOutboundQueue = DEFAULT_MAX_OUTBOUND_QUEUE,
    scheduleReconnect = defaultScheduleReconnect,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    scheduleConnectTimeout = defaultScheduleReconnect,
  } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let cancelReconnect: (() => void) | null = null;
  // WORKBENCH-LOCAL (CL-3826): pending connect-attempt timer. Link-scoped so
  // close() and a superseding connect() can both cancel a stale attempt's
  // timer, matching how pingTimer/cancelReconnect are owned.
  let cancelConnectTimeout: (() => void) | null = null;
  function clearConnectTimeout(): void {
    if (cancelConnectTimeout !== null) {
      cancelConnectTimeout();
      cancelConnectTimeout = null;
    }
  }
  let lastPongAt = 0;
  // WORKBENCH-LOCAL (CL-2405): backoff state, persisted across reconnect
  // attempts and reset on a successful `open`. `reconnectAttempt` drives the
  // exponential delay; `firstFailureAt` anchors the sustained-failure
  // escalation window; `sustainedWarnEmitted` keeps that escalation to one
  // WARN per outage.
  let reconnectAttempt = 0;
  let firstFailureAt = 0;
  let sustainedWarnEmitted = false;

  /**
   * WORKBENCH-LOCAL (CL-2405): schedule the next reconnect, idempotently.
   * Both the WebSocket `error` and `close` handlers call this: Bun's event
   * ordering on a failed connect is spec-divergent (it may emit `error`
   * without a matching `close`), so driving reconnect from a single guarded
   * path structurally removes the "error fired, close didn't, link never
   * retries" failure mode. The `cancelReconnect !== null` guard makes a
   * second call within the same disconnect a no-op. Delay grows exponentially
   * from `reconnectDelayMs` to `maxReconnectDelayMs` with +/-20% jitter;
   * connect-phase failures stay at debug until the link has been down past
   * SUSTAINED_FAILURE_WARN_MS, when a single WARN fires.
   */
  function scheduleReconnectOnce(): void {
    if (closed || cancelReconnect !== null) return;

    const now = Date.now();
    if (firstFailureAt === 0) firstFailureAt = now;
    const downForMs = now - firstFailureAt;

    if (downForMs >= SUSTAINED_FAILURE_WARN_MS && !sustainedWarnEmitted) {
      sustainedWarnEmitted = true;
      logger.warn`Hub unreachable for ${String(Math.round(downForMs / 1000))}s, still retrying`;
    }

    const base = Math.min(
      reconnectDelayMs * 2 ** reconnectAttempt,
      maxReconnectDelayMs,
    );
    // +/-20% jitter so a fleet of sidecars recovering from the same hub
    // redeploy spread their retries instead of reconnecting in lockstep.
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(base + jitter));
    reconnectAttempt += 1;

    logger.debug`Scheduling hub reconnect in ${String(delay)}ms (attempt ${String(reconnectAttempt)})`;

    cancelReconnect = scheduleReconnect(() => {
      cancelReconnect = null;
      // Defense in depth for fake or misbehaving schedulers whose cancel
      // function is a no-op: re-check `closed` before re-entering
      // connect() so a fired-but-not-yet-executed callback after close()
      // does not propagate the "called after close" throw.
      if (closed) return;
      connect();
    }, delay);
  }

  const packReceiver = createPackReceiver();
  // One sender owns the agent-state push path (`handleSyncRequest`,
  // `handleAgentUndeploy`) and the workflow-run push path
  // (`pushWorkflowRunPack`). transferIds for the two flows live in
  // disjoint namespaces (`undeploy-*` / sync-supplied / `workflow-run-*`),
  // so a single pending-id map is unambiguous; the protocol logic
  // (chunking, ack-handshake) lives once in `@intx/pack-transport`.
  const packSender = createPackSender({ sendFrame: (frame) => send(frame) });

  // Serialize frame processing so async handlers (deploy, undeploy)
  // cannot race against each other.
  let messageQueue: Promise<void> = Promise.resolve();

  // Outbound frames queued while disconnected.
  const queue: SidecarFrame[] = [];

  function send(frame: SidecarFrame): void {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return;
    }
    if (queue.length >= maxOutboundQueue) {
      logger.warn`Outbound queue full, dropping oldest frame`;
      queue.shift();
    }
    queue.push(frame);
  }

  function flush(): void {
    while (
      queue.length > 0 &&
      ws !== null &&
      ws.readyState === WebSocket.OPEN
    ) {
      ws.send(JSON.stringify(queue.shift()));
    }
  }

  // Wire the transport's remote send handler to push mail.outbound frames
  // for routing. These carry only the raw message and recipients — the hub
  // routes them to the destination sidecar.
  transport.setRemoteSendHandler(async (rawMessage, recipients) => {
    const encoded = base64Encode(rawMessage);
    send({
      type: "mail.outbound",
      rawMessage: encoded,
      recipients,
    });
  });

  // Forward every send to the hub for audit and event emission. Local-only
  // sends are marked delivered: true so the hub does not re-route them.
  // Remote sends are marked delivered: true as well — routing was already
  // handled by the RemoteSendHandler above.
  transport.addMessageSentHandler(async (ctx) => {
    const encoded = base64Encode(ctx.rawMessage);
    const sessionId = sessions.getSessionId(ctx.senderAddress);
    send({
      type: "mail.outbound",
      rawMessage: encoded,
      recipients: ctx.recipients,
      senderAddress: ctx.senderAddress,
      ...(sessionId !== undefined ? { sessionId } : {}),
      messageId: ctx.messageId,
      to: ctx.to,
      ...(ctx.cc.length > 0 ? { cc: ctx.cc } : {}),
      delivered: true,
    });
  });

  async function handleAgentDeploy(frame: AgentDeployFrame): Promise<void> {
    try {
      // The deploy router (production: the sidecar's workflow-run deploy
      // router) stages the deploy through the substrate and returns the
      // deploy public key the link folds into the outbound ack. The link
      // itself does not re-decide; routing lives on the router side of
      // the seam.
      const result = await deployRouter.deploy(frame);
      send({
        type: "agent.deploy.ack",
        agentAddress: frame.agentAddress,
        publicKey: result.publicKey,
      });
      logger.info`Deployed agent ${frame.agentAddress}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        type: "agent.error",
        agentAddress: frame.agentAddress,
        error: message,
      });
    }
  }

  // WORKBENCH-LOCAL (CL-3104): hibernate flavor of agent.undeploy. Selected
  // by the well-known reason marker; tears down runtime residency (routing
  // registrations, supervisor/child) while preserving every durable on-disk
  // artifact — no state-pack push, no `deleteAgentDir`, no `forgetAgent`.
  // The ack drops the address from the hub's routable set; that unroutability
  // is what makes the next gate signal's `ensureDeploymentRoutable`
  // re-establish the deployment and resume the parked run.
  //
  // On failure the ack is withheld — NOT to keep the address routable
  // (interchange's `sendAgentUndeploy` timeout arm removes the address
  // BEFORE rejecting, so the hub unroutes either way) but to make the
  // failure LOUD at the hub caller (the reconciler counts the rejection)
  // instead of a silent fake success. The teardown is idempotent, so a
  // transient failure is retried once here; a deployment left resident
  // after both attempts is self-healed by the deploy branch's
  // resident-supervisor guard when the wake re-deploy arrives
  // (workflow-host-wiring.ts, CL-3104).
  async function handleAgentHibernate(
    frame: AgentUndeployFrame,
  ): Promise<void> {
    const hibernate = deployRouter.hibernate;
    if (hibernate === undefined) {
      logger.error`Hibernate requested for ${frame.agentAddress} but the deploy router has no hibernate hook; leaving the deployment resident (no ack)`;
      return;
    }
    try {
      await hibernate(frame);
    } catch (firstErr) {
      const firstMsg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);
      logger.warn`Deploy router hibernate hook failed for ${frame.agentAddress}: ${firstMsg}; retrying once`;
      try {
        await hibernate(frame);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error`Deploy router hibernate hook failed again for ${frame.agentAddress}: ${msg}; leaving the deployment resident (no ack)`;
        return;
      }
    }

    // Same bootstrap-flag prune as the full undeploy: the wiring's hibernate
    // clears the deployment's delta cursor, so the next push after a wake
    // must re-run the bootstrap-retry arm.
    pruneWorkflowRunBootstrap(frame.agentAddress);

    send({
      type: "agent.undeploy.ack",
      agentAddress: frame.agentAddress,
      statePushed: false,
    });
    logger.info`Hibernated deployment ${frame.agentAddress}: ${frame.reason}`;
  }

  async function handleAgentUndeploy(frame: AgentUndeployFrame): Promise<void> {
    // WORKBENCH-LOCAL (CL-3104): reason-scoped hibernate branch.
    if (frame.reason === WORKFLOW_HIBERNATE_UNDEPLOY_REASON) {
      await handleAgentHibernate(frame);
      return;
    }

    let statePushed = false;

    // Release per-deployment routing state the deploy router installed
    // for this address (multi-step mail/signal/drain handlers and the
    // deployment-address mapping) before the session tears down. With
    // the registrations released, any in-flight `signal.deliver` /
    // `drain.deliver` / `mail.inbound` frame that lands during teardown
    // is rejected by the router rather than dispatched into a
    // soon-to-be-orphaned supervisor handler. Test stubs omit the hook;
    // an absent hook means there was nothing to release.
    if (deployRouter.undeploy !== undefined) {
      try {
        await deployRouter.undeploy(frame);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn`Deploy router undeploy hook failed for ${frame.agentAddress}: ${msg}`;
      }
    }

    // Prune `workflowRunPackBootstrapped` entries recorded under this
    // address so a future workflow-run-repo reset for the same
    // `(kind, id, ref)` triple re-runs the bootstrap-retry arm.
    pruneWorkflowRunBootstrap(frame.agentAddress);

    // Best-effort state push to the hub before deleting the directory.
    // statePushed reflects whether we sent the pack frames, not whether
    // the hub acknowledged them. We intentionally skip waiting for
    // repo.pack.ack here to avoid blocking the undeploy on a round-trip
    // that may never complete if the hub is shutting down -- so the
    // pending Promise's rejection on disconnect is intentionally
    // swallowed below.
    try {
      const { pack, commitSha, ref } = await sessions.createStatePack(
        frame.agentAddress,
      );
      const repoId: RepoId = {
        kind: "agent-state",
        id: frame.agentAddress,
      };

      void packSender
        .send({
          agentAddress: frame.agentAddress,
          repoId,
          transferId: `undeploy-${frame.agentAddress}`,
          pack,
          ref,
          commitSha,
        })
        .catch(() => {
          // Intentional: undeploy's pack push is best-effort. See above.
        });

      statePushed = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`State push failed for ${frame.agentAddress}: ${msg}`;
    }

    // Delete the agent directory.
    try {
      await sessions.deleteAgentDir(frame.agentAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`Failed to delete agent directory for ${frame.agentAddress}: ${msg}`;
    }

    keyStore.forgetAgent(frame.agentAddress);

    send({
      type: "agent.undeploy.ack",
      agentAddress: frame.agentAddress,
      statePushed,
    });
    logger.info`Undeployed agent ${frame.agentAddress}: ${frame.reason}`;
  }

  async function handleChallenge(frame: ChallengeFrame): Promise<void> {
    const responses: { address: string; signature: string }[] = [];

    for (const { address, nonce } of frame.challenges) {
      const nonceBytes = hexDecode(nonce);
      const addressBytes = new TextEncoder().encode(address);
      const payload = new Uint8Array(nonceBytes.length + addressBytes.length);
      payload.set(nonceBytes);
      payload.set(addressBytes, nonceBytes.length);

      const sig = await keyStore.signChallenge(address, payload);
      if (sig === null) {
        logger.warn`No key pair for challenged address ${address}`;
        continue;
      }

      responses.push({
        address,
        signature: hexEncode(sig),
      });
    }

    send({ type: "challenge.response", responses });

    // Signal the workflow-run pack pusher that these addresses are becoming
    // routable again, so it can re-drive a push a disconnect cancelled. Fires
    // AFTER the response is sent: the hub routes each verified address before
    // it processes any pack the pusher re-ships in reaction (both frame
    // families queue on the hub's per-connection chain), so the re-ship
    // cannot arrive at the hub ahead of the address's routing write.
    if (onWorkflowAddressesRoutable !== undefined && responses.length > 0) {
      onWorkflowAddressesRoutable(responses.map((r) => r.address));
    }
  }

  async function handleChallengeFailed(
    frame: ChallengeFailedFrame,
  ): Promise<void> {
    // The hub rejected this agent during reconnect -- forget its key
    // material so the address is freed for future deploys.
    keyStore.forgetAgent(frame.address);

    logger.warn`Challenge failed for ${frame.address}, agent torn down: ${frame.reason}`;
  }

  function handlePackPush(frame: PackPushFrame): void {
    const reason = packReceiver.handlePush(frame);
    if (reason !== null) {
      send({
        type: "repo.pack.reject",
        agentAddress: frame.agentAddress,
        repoId: frame.repoId,
        transferId: frame.transferId,
        reason,
      });
    }
  }

  async function handlePackDone(frame: PackDoneFrame): Promise<void> {
    const result = packReceiver.handleDone(frame);
    if (result === null) {
      send({
        type: "repo.pack.reject",
        agentAddress: frame.agentAddress,
        repoId: frame.repoId,
        transferId: frame.transferId,
        reason: "corrupt",
      });
      return;
    }

    try {
      if (frame.mountPath !== undefined) {
        // Asset pack: route to the workspace materializer. Use
        // frame.agentAddress for destination routing — frame.repoId.id
        // names the source asset at the hub, which is a different
        // entity than the destination agent.
        await sessions.applyAssetPack(
          frame.agentAddress,
          frame.mountPath,
          result.pack,
          result.ref,
          result.commitSha,
        );
      } else {
        const verifyCommit = (payload: string, signature: string) =>
          keyStore.verifyDeployCommit(frame.agentAddress, payload, signature);

        await sessions.applyDeployPack(
          frame.agentAddress,
          result.pack,
          result.ref,
          result.commitSha,
          frame.transferId,
          verifyCommit,
        );
      }
      send({
        type: "repo.pack.ack",
        agentAddress: frame.agentAddress,
        repoId: frame.repoId,
        transferId: frame.transferId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // asset_materialization_failed errors mirror deploy materialization
      // errors into the same `corrupt` bucket — finer-grained
      // classification is out of scope for v1 asset packs.
      const reason = msg.startsWith("sha_mismatch")
        ? "sha_mismatch"
        : msg.startsWith("signature_invalid") ||
            msg.startsWith("signature_unsigned")
          ? "signature_invalid"
          : "corrupt";
      logger.warn`Pack apply failed for ${frame.agentAddress}: ${msg}`;
      send({
        type: "repo.pack.reject",
        agentAddress: frame.agentAddress,
        repoId: frame.repoId,
        transferId: frame.transferId,
        reason,
      });
    }
  }

  // Counter the boot edge consumes via `pushWorkflowRunPack` to mint
  // collision-free transferIds. Lives on the link so undeploy /
  // sync-request / workflow-run all share one monotonically increasing
  // sequence space.
  let workflowRunPackCounter = 0;

  // Per-(repoId.id, ref) flag tracking whether at least one workflow-run
  // pack push has been accepted by the hub, and a per-(repoId.id, ref)
  // serialization queue. Both are needed because the hub's
  // `receiveWorkflowRunPack` resolves the ref OUTSIDE the substrate's
  // per-repo lock, then enters `receivePack` which acquires the lock
  // and calls `initRepo` BEFORE the CAS check. See the extended note in
  // `runWithBootstrap` for the two races these close.
  const workflowRunPackBootstrapped = new Set<string>();
  const workflowRunPackQueues = new Map<string, Promise<void>>();
  // Reverse index: agentAddress -> bootstrap keys recorded under that
  // address. `handleAgentUndeploy` / `handleAgentHibernate` consult this to
  // prune `workflowRunPackBootstrapped` entries owned by the just-torn-down
  // deployment so a future workflow-run-repo reset for the same
  // `(kind, id, ref)` triple re-runs the bootstrap-retry arm instead of
  // skipping it on the stale flag and failing with `non_fast_forward`.
  const workflowRunPackBootstrappedByAddress = new Map<string, Set<string>>();
  function workflowRunPackKey(repoId: RepoId, ref: string): string {
    return `${repoId.kind}:${repoId.id}:${ref}`;
  }

  function pruneWorkflowRunBootstrap(agentAddress: string): void {
    const bootstrapped = workflowRunPackBootstrappedByAddress.get(agentAddress);
    if (bootstrapped !== undefined) {
      for (const key of bootstrapped) {
        workflowRunPackBootstrapped.delete(key);
      }
      workflowRunPackBootstrappedByAddress.delete(agentAddress);
    }
  }

  async function handleSyncRequest(frame: SyncRequestFrame): Promise<void> {
    const { agentAddress, transferId } = frame;
    try {
      const { pack, commitSha, ref } =
        await sessions.createStatePack(agentAddress);
      const repoId: RepoId = { kind: "agent-state", id: agentAddress };

      await packSender.send({
        agentAddress,
        repoId,
        transferId,
        pack,
        ref,
        commitSha,
      });

      logger.info`State push complete for ${agentAddress} (${commitSha.slice(0, 8)})`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`State push failed for ${agentAddress}: ${msg}`;
    }
  }

  function handlePackAck(frame: PackAckFrame): void {
    if (!packSender.handleAck(frame)) {
      logger.warn`Received repo.pack.ack for unknown transferId ${frame.transferId}`;
    }
  }

  function handlePackReject(frame: PackRejectFrame): void {
    if (!packSender.handleReject(frame)) {
      logger.warn`Received repo.pack.reject for unknown transferId ${frame.transferId}`;
    }
  }

  async function handleSignalDeliver(frame: SignalDeliverFrame): Promise<void> {
    if (signalInboundRouter === undefined) {
      logger.warn`Received signal.deliver for ${frame.agentAddress} but no signalInboundRouter is wired; dropping`;
      return;
    }
    try {
      const routed = await signalInboundRouter.tryRoute(frame);
      if (!routed) {
        logger.warn`signal.deliver for ${frame.agentAddress} did not match any registered deployment; dropping`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`signal.deliver delivery failed for ${frame.agentAddress}: ${msg}`;
    }
  }

  async function handleDrainDeliver(frame: DrainDeliverFrame): Promise<void> {
    if (drainInboundRouter === undefined) {
      logger.warn`Received drain.deliver for ${frame.agentAddress} but no drainInboundRouter is wired; dropping`;
      return;
    }
    try {
      const routed = await drainInboundRouter.tryRoute(frame);
      if (!routed) {
        logger.warn`drain.deliver for ${frame.agentAddress} did not match any registered deployment; dropping`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn`drain.deliver delivery failed for ${frame.agentAddress}: ${msg}`;
    }
  }

  async function handleSourcesUpdate(frame: SourcesUpdateFrame): Promise<void> {
    // `sources.update` is request/ack (the hub awaits a reply within its
    // request timeout), so every path answers `session.ack` or
    // `session.error` -- unlike the fire-and-forget signal/drain frames
    // that log and drop. A missing router still answers, or the hub hangs.
    if (sourcesInboundRouter === undefined) {
      send({
        type: "session.error",
        requestId: frame.requestId,
        error: "no sourcesInboundRouter is wired",
      });
      return;
    }
    try {
      const routed = await sourcesInboundRouter.tryRoute(frame);
      if (routed) {
        send({ type: "session.ack", requestId: frame.requestId });
      } else {
        send({
          type: "session.error",
          requestId: frame.requestId,
          error: `no deployment registered for ${frame.agentAddress}`,
        });
      }
    } catch (err) {
      // A registered address whose rotation was rejected: an invalid list
      // (the router validates before dispatch) or the supervisor's
      // `deliverSources` throwing (e.g. a recycling phase). The reason
      // rides back verbatim so the hub sees why the rotation failed.
      const msg = err instanceof Error ? err.message : String(err);
      send({
        type: "session.error",
        requestId: frame.requestId,
        error: msg,
      });
    }
  }

  async function pushWorkflowRunPack(opts: {
    agentAddress: string;
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
  }): Promise<void> {
    const key = workflowRunPackKey(opts.repoId, opts.ref);

    async function sendOnce(): Promise<void> {
      const transferId = `workflow-run-${++workflowRunPackCounter}-${opts.repoId.id}`;
      await packSender.send({
        agentAddress: opts.agentAddress,
        repoId: opts.repoId,
        transferId,
        pack: opts.pack,
        ref: opts.ref,
        commitSha: opts.commitSha,
      });
    }

    async function runWithBootstrap(): Promise<void> {
      if (workflowRunPackBootstrapped.has(key)) {
        await sendOnce();
        return;
      }
      try {
        await sendOnce();
      } catch (first) {
        // A disconnect that cancelled the transfer (`cancelAll` on the
        // link's reconnect `open`) is NOT the initRepo bootstrap race: the
        // link just cycled, and re-sending on the fresh, not-yet-challenged
        // connection would ship to a hub that has dropped this address's
        // route (the frames land "unrouted"). Reconnect recovery is owned by
        // the pushing store's post-challenge re-drive, not by this
        // fast-retry, so re-throw and let the caller latch the failure. Only
        // the genuine bootstrap race -- a receiver reject against an
        // uninitialised hub repo -- retries here.
        if (isConnectionLost(first)) {
          throw first;
        }
        // A receiver `path_violation` is a DETERMINISTIC content rejection
        // (the hub's tree validator refused the pack — e.g. an append-only
        // event blob diverging from the hub's copy), not the transient
        // initRepo bootstrap race. Retrying re-sends the identical pack and
        // fails identically, forever — observed on staging as an endless
        // transferId-burning loop against a legacy repo whose pre-guard
        // seq-0 event survives hub-side. Fail loud once and let the caller
        // latch it; only an operator action (teardown / repo repair) can
        // resolve a deterministic rejection.
        const reason = first instanceof Error ? first.message : String(first);
        if (reason.includes("path_violation")) {
          logger.error`Workflow-run pack push permanently rejected for ${opts.repoId.id}/${opts.ref} (deterministic content rejection, not retried): ${reason}`;
          throw first;
        }
        // First push to a never-bootstrapped (repoId, ref) lost the
        // race with the hub substrate's `receivePack` initRepo step. The
        // hub has now initialized the repo as a side effect of the failed
        // push; the retry uses the same pack but observes the bootstrap
        // genesis as the CAS baseline and lands.
        logger.warn`Workflow-run pack push bootstrap retry for ${opts.repoId.id}/${opts.ref}: ${reason}`;
        await sendOnce();
      }
      workflowRunPackBootstrapped.add(key);
      let perAddress = workflowRunPackBootstrappedByAddress.get(
        opts.agentAddress,
      );
      if (perAddress === undefined) {
        perAddress = new Set<string>();
        workflowRunPackBootstrappedByAddress.set(opts.agentAddress, perAddress);
      }
      perAddress.add(key);
    }

    // Serialize pushes per (repoId, ref). The hub's `receiveWorkflowRunPack`
    // does its `resolveRef` outside the substrate's per-repo lock, so
    // overlapping pushes from this sender would each observe a stale
    // baseline and the second to acquire the hub-side lock would
    // reject with `non_fast_forward`. Chaining through this queue
    // keeps the receive ordering consistent end-to-end.
    const prior = workflowRunPackQueues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => runWithBootstrap());
    workflowRunPackQueues.set(key, next);
    try {
      await next;
    } finally {
      // Drop the queue entry when the chain has settled and no
      // follower has appended, so a long-idle (repoId, ref) does not
      // hold a dead promise reference. A racing append replaces this
      // entry before we get here; the conditional avoids clobbering
      // a still-active chain.
      if (workflowRunPackQueues.get(key) === next) {
        workflowRunPackQueues.delete(key);
      }
    }
  }

  async function handleMessage(data: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(data) as unknown;
    } catch {
      logger.warn`Received unparseable frame from hub`;
      return;
    }
    const validated = HubFrame(raw);
    if (validated instanceof type.errors) {
      // A malformed request/ack frame must still be answered, or the hub's
      // request hangs to its timeout. `sources.update` and `agent.deploy`
      // usually keep an intact correlation key even when a nested field is
      // malformed, so reply with the matching error frame; a fire-and-forget
      // frame (or one with no recoverable key) is only logged and dropped.
      answerMalformedRequestFrame(raw, validated.summary, send);
      logger.warn`Invalid hub frame: ${validated.summary}`;
      return;
    }
    const frame = validated;

    switch (frame.type) {
      case "mail.inbound": {
        const rawBytes = base64Decode(frame.rawMessage);
        // Supervised deployments register the deployment-level mail
        // address on `mailInboundRouter` once their supervisor spawns;
        // that handler delivers the bytes to the supervisor's mail-bus
        // subscription, which is what the workflow-host's `awaitSignal`
        // listens on. Mail for an address with no registered handler has
        // no receiver -- the in-process session runtime that once backed
        // it is retired -- so it is logged and dropped.
        //
        // Guard the router call with try/catch so a throwing handler
        // does not reject this `handleMessage` promise and wedge the
        // per-connection `messageQueue` chain.
        let routed = false;
        if (mailInboundRouter !== undefined) {
          try {
            routed = mailInboundRouter.tryRoute(frame.agentAddress, rawBytes);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn`mail.inbound router threw for ${frame.agentAddress}: ${msg}`;
          }
        }
        if (!routed) {
          logger.warn`Dropping mail.inbound for ${frame.agentAddress}: no registered handler`;
        }
        break;
      }
      case "agent.deploy":
        await handleAgentDeploy(frame);
        break;
      case "agent.undeploy":
        await handleAgentUndeploy(frame);
        break;
      case "challenge":
        await handleChallenge(frame);
        break;
      // WORKBENCH-LOCAL (CL-3779): `pong` is handled inline in the `ws.message`
      // listener before enqueuing, so the heartbeat cannot be starved by awaited
      // pack-apply I/O ahead of it on this serial queue. A real `pong` is valid
      // JSON and always takes that inline path, so this arm is unreachable for
      // inline-handled pongs; it is kept for parity with upstream
      // `@intx/hub-agent` (minimizing fork drift), not as a live code path.
      case "pong":
        lastPongAt = Date.now();
        break;
      case "challenge.failed":
        await handleChallengeFailed(frame);
        break;
      case "repo.pack.push":
        handlePackPush(frame);
        break;
      case "repo.pack.done":
        await handlePackDone(frame);
        break;
      case "sync.request":
        void handleSyncRequest(frame);
        break;
      case "signal.deliver":
        await handleSignalDeliver(frame);
        break;
      case "drain.deliver":
        await handleDrainDeliver(frame);
        break;
      case "sources.update":
        await handleSourcesUpdate(frame);
        break;
      case "repo.pack.ack":
        handlePackAck(frame);
        break;
      case "repo.pack.reject":
        handlePackReject(frame);
        break;
      default:
        logger.warn`Unknown frame type from hub: ${(frame as { type: string }).type}`;
    }
  }

  function connect(): void {
    // Reconnect cancellation in close() is the load-bearing protection
    // against post-close reconnect attempts. A caller invoking connect()
    // after close() is a misuse, not a recoverable state — fail loudly.
    if (closed) {
      throw new Error("HubLink.connect called after close");
    }

    // WORKBENCH-LOCAL (CL-3826): a superseding connect() disarms any stale
    // attempt's timer so it can never touch this attempt's socket.
    clearConnectTimeout();

    const socket = new WebSocket(hubURL);
    ws = socket;

    // WORKBENCH-LOCAL (CL-2405): whether this particular socket ever reached
    // `open`. Distinguishes a real established-then-dropped disconnect (worth
    // an info log) from a connect attempt that never succeeded (expected
    // during a redeploy window, kept at debug).
    let everOpened = false;

    // WORKBENCH-LOCAL (CL-3826): bound this attempt's wait for `open`. The
    // closure captures this attempt's socket (not the shared `ws`) and closes
    // it only while still CONNECTING, so a timer racing an already-delivered
    // `open` — or outliving its own attempt — can never kill a live socket.
    cancelConnectTimeout = scheduleConnectTimeout(() => {
      cancelConnectTimeout = null;
      if (socket.readyState !== WebSocket.CONNECTING) return;
      logger.warn`Hub connect attempt timed out after ${String(connectTimeoutMs)}ms, closing`;
      socket.close();
    }, connectTimeoutMs);

    ws.addEventListener("open", () => {
      clearConnectTimeout();
      everOpened = true;
      // WORKBENCH-LOCAL (CL-2405): a healthy connection resets the backoff so
      // the next disconnect starts fast again, and clears the sustained-failure
      // escalation.
      reconnectAttempt = 0;
      firstFailureAt = 0;
      sustainedWarnEmitted = false;
      logger.info`Connected to hub at ${hubURL}`;

      lastPongAt = Date.now();
      pingTimer = setInterval(() => {
        if (Date.now() - lastPongAt >= pingIntervalMs * 2) {
          logger.warn`Hub pong timeout, closing connection`;
          if (pingTimer !== null) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
          ws?.close();
          return;
        }
        send({ type: "ping" });
      }, pingIntervalMs);

      packReceiver.reset();
      packSender.cancelAll(CONNECTION_LOST_REASON);

      // Announce this sidecar to the hub for routing. The hub learns of a
      // sidecar only from a register frame; `connections` is the map
      // `sendAgentDeploy` consults to route a deploy. This first-connect
      // register carries no addresses -- it only establishes the sidecar in
      // that map. Restored deployments are announced through the CHALLENGED
      // reconnect frame below.
      send({
        type: "register",
        sidecarId,
        token,
        agentAddresses: [],
      });
      flush();

      // Re-announce every deployment restored at boot through the reconnect
      // frame so the hub proves ownership of each address (Ed25519
      // challenge/response, signed by the deployment's own key via
      // `signChallenge`) before it routes mail. Routing a restored address
      // through `register`/`workflowAddresses` -- unchallenged -- would let a
      // rogue sidecar holding a valid token reclaim a victim's address.
      // Restore runs before `connect()`, so `getWorkflowAddresses()` is
      // already populated; the only async work is reading each address's
      // deploy ref for the hub's deploy-pack freshness check.
      const restoredAddresses = getWorkflowAddresses();
      if (restoredAddresses.length > 0) {
        void (async () => {
          try {
            const deployRefs: Record<string, string> = {};
            for (const address of restoredAddresses) {
              const ref = await sessions.getDeployRef(address);
              if (ref !== null) {
                deployRefs[address] = ref;
              }
            }
            send({
              type: "reconnect",
              sidecarId,
              token,
              agentAddresses: restoredAddresses,
              ...(Object.keys(deployRefs).length > 0 ? { deployRefs } : {}),
            });
            flush();
          } catch (err) {
            // A failing deploy-ref read (corrupt or unreadable ref state)
            // must not silently drop the reconnect. Surface the failure and
            // close the socket to force a clean reconnect retry.
            const msg = err instanceof Error ? err.message : String(err);
            logger.error`Deployment re-announce failed, closing connection: ${msg}`;
            ws?.close();
          }
        })();
      }
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        // Attach a tail `.catch` to the chained handler so any
        // unhandled throw inside `handleMessage` is observed and
        // surfaces as a logged warning rather than rejecting the
        // shared `messageQueue` chain. A rejected chain wedges every
        // subsequent `messageQueue.then(...)` -- including the
        // heartbeat `pong` path -- and silently stalls the link.
        //
        // This chain also serializes inbound frames: each frame's
        // handler runs to completion before the next begins. A downstream
        // invariant depends on that ordering -- the workflow
        // source-rotation persist rolls back on failure assuming no second
        // rotation is in flight, which holds only because sources.update
        // frames are processed one at a time here.
        const data = event.data;
        // WORKBENCH-LOCAL (CL-3779): the heartbeat `pong` must not be starved
        // by awaited pack-apply I/O ahead of it on the shared `messageQueue`.
        // A `repo.pack.done` arm calls `await handlePackDone(...)` (isomorphic-git
        // disk writes) inline on this serial chain; a pack that holds the queue
        // longer than the pong window (`pingIntervalMs * 2`) delays the queued
        // `pong`, `lastPongAt` goes stale, and the ping timer closes this
        // otherwise-healthy socket. Handle `pong` inline here, ahead of the
        // queue. All other frames enqueue exactly as before.
        //
        // Length gate: a `pong` frame is ~16 bytes, so only attempt the inline
        // parse on tiny frames. This avoids a second synchronous `JSON.parse`
        // on the hottest/largest frames (e.g. `repo.pack.push` chunks).
        if (data.length < 64) {
          let inboundType: unknown;
          try {
            inboundType = (JSON.parse(data) as { type?: unknown }).type;
          } catch {
            inboundType = undefined;
          }
          if (inboundType === "pong") {
            lastPongAt = Date.now();
            return;
          }
        }
        messageQueue = messageQueue.then(() =>
          handleMessage(data).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn`Unhandled error in handleMessage: ${msg}`;
          }),
        );
      }
    });

    ws.addEventListener("close", (event) => {
      clearConnectTimeout();
      const closeEvent = event as CloseEvent;
      const code = closeEvent.code ?? "unknown";
      const reason = closeEvent.reason ? `, reason: ${closeEvent.reason}` : "";
      // WORKBENCH-LOCAL (CL-2405): an established connection dropping is worth
      // an info breadcrumb; a connect attempt that never opened is the
      // expected redeploy-window case and stays at debug.
      if (everOpened) {
        logger.info`Disconnected from hub (code: ${code}${reason})`;
      } else {
        logger.debug`Hub connect attempt closed before opening (code: ${code}${reason})`;
      }
      ws = null;
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      // The hub dropped every route this link held. Block workflow-run pushes
      // for the deployments it hosts until the reconnect challenge re-routes
      // them, so the coalescing pusher does not re-ship onto the fresh,
      // not-yet-challenged connection (which the hub drops as "unrouted").
      if (onWorkflowAddressesUnroutable !== undefined) {
        const hosted = getWorkflowAddresses();
        if (hosted.length > 0) {
          onWorkflowAddressesUnroutable(hosted);
        }
      }
      scheduleReconnectOnce();
    });

    ws.addEventListener("error", (event) => {
      clearConnectTimeout();
      const errorEvent = event as ErrorEvent;
      const detail =
        errorEvent.message ??
        (errorEvent.error instanceof Error ? errorEvent.error.message : null) ??
        errorEvent.type ??
        "unknown";
      // WORKBENCH-LOCAL (CL-2405): expected while the hub is briefly
      // unreachable (redeploy). Kept at debug; the sustained-failure WARN in
      // scheduleReconnectOnce is the signal a real outage is underway. Routing
      // reconnect through scheduleReconnectOnce here too covers Bun emitting
      // `error` without a following `close` on a failed connect.
      logger.debug`WebSocket error: ${detail}`;
      scheduleReconnectOnce();
    });
  }

  function close(): void {
    closed = true;
    clearConnectTimeout();
    if (cancelReconnect !== null) {
      cancelReconnect();
      cancelReconnect = null;
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (ws !== null) {
      ws.close();
      ws = null;
    }
  }

  const sendEvent: SessionEventSink = (agentAddress, sessionId, event) => {
    send({
      type: "agent.event",
      agentAddress,
      sessionId,
      event,
    });
  };

  const sendSignalCorrelationRegister: HubLink["sendSignalCorrelationRegister"] =
    (registration) => {
      const frame: SignalCorrelationRegisterFrame = {
        type: "signal.correlation.register",
        correlationId: registration.correlationId,
        runId: registration.runId,
        deploymentId: registration.deploymentId,
        agentAddress: registration.agentAddress,
        kind: registration.kind,
      };
      send(frame);
    };

  return {
    connect,
    close,
    sendEvent,
    sendSignalCorrelationRegister,
    pushWorkflowRunPack,
  };
}
