// Workflow-run pack push client.
//
// Sits between the boot-edge substrate facade and the hub-link's
// `pushWorkflowRunPack` wire surface. The facade fires this client
// after a successful supervisor-authored `writeTreePreservingPrefix`
// against a `workflow-run` repo; the client builds the new pack via
// `RepoStore.createPack` under the supervisor principal and ships it
// over the hub link. The hub routes the pack to its workflow-run
// receiver because `repoId.kind === "workflow-run"`.
//
// The client does NOT mint a fresh signing key, transferId, or
// principal kind. The principal is the same `WorkflowRunSupervisorPrincipal`
// shape the supervisor uses for `writeTreePreservingPrefix`; the
// transferId is minted inside `HubLink.pushWorkflowRunPack`.

import fs from "node:fs";

import { type } from "arktype";
import git from "isomorphic-git";

import { getLogger } from "@intx/log";
import { SourcesUpdatedData } from "@workbench/workflow-host";
import { collectReachableObjects } from "@workbench/storage-isogit";
import type { InferenceSource } from "@intx/types/runtime";
import type {
  RepoId,
  RepoStore,
  WorkflowRunSupervisorPrincipal,
} from "@intx/hub-sessions";
import type { HubLink } from "@workbench/hub-agent";

import {
  DEFAULT_WORKFLOW_RUN_PACK_MAX_COMMITS,
  DEFAULT_WORKFLOW_RUN_PACK_MAX_OBJECTS,
  type WorkflowRunPackLimits,
} from "./config";

const logger = getLogger([
  "interchange",
  "sidecar",
  "workflow-run-pack-client",
]);

// WORKBENCH-LOCAL (CL-2340): not in upstream interchange — preserve on every
// pin-bump re-sync. The base ack-gated cursor (createPack builds the delta from
// the last-ACKED tip; commitPackedTip advances only on ack) has CONVERGED
// upstream, so only the size-ceiling remains a workbench divergence: a single
// wedged workflow run can accumulate an un-acked delta whose packfile, built in
// one shot, OOMs the SHARED sidecar and takes every other deployment down with
// it. A pre-flight walk (below) trips a safety ceiling and fails just that run
// BEFORE the giant packfile is ever built, rather than the process.
export class WorkflowRunPackTooLargeError extends Error {
  readonly repoId: string;
  readonly ref: string;
  readonly commitCount: number;
  readonly objectCount: number;
  readonly limits: WorkflowRunPackLimits;
  constructor(args: {
    repoId: string;
    ref: string;
    commitCount: number;
    objectCount: number;
    limits: WorkflowRunPackLimits;
  }) {
    super(
      `workflow-run pack for ${args.repoId}/${args.ref} exceeded the safety ceiling ` +
        `(${String(args.commitCount)} commits / ${String(args.objectCount)} objects > ` +
        `limit ${String(args.limits.maxCommits)} commits / ${String(args.limits.maxObjects)} objects); failing run`,
    );
    this.name = "WorkflowRunPackTooLargeError";
    this.repoId = args.repoId;
    this.ref = args.ref;
    this.commitCount = args.commitCount;
    this.objectCount = args.objectCount;
    this.limits = args.limits;
  }
}

// WORKBENCH-LOCAL (CL-2340): pre-flight the delta the substrate's `createPack`
// is about to build. Walk the first-parent chain from the ref tip back to
// `sinceTip` (the last-ACKED commit, exclusive — the same base createPack packs
// from, since this client is the sole advancer of that cursor), counting
// commits + reachable objects. Throw before `createPack` runs if the delta
// exceeds the ceiling, so the one-shot in-memory packfile that OOMs the shared
// sidecar is never built. Healthy runs stop at `sinceTip` after a one-commit
// delta, so this adds only a bounded walk on the hot path; a wedged run trips
// the ceiling and fails just that run. The ceiling is a safety trip, not an
// exact byte budget: `seen` can overshoot by one commit's reachable set (we add
// then test), which is harmless because the throw still precedes the pack build.
async function assertDeltaWithinCeiling(
  dir: string,
  ref: string,
  sinceTip: string | null,
  limits: WorkflowRunPackLimits,
  repoIdLabel: string,
): Promise<void> {
  let commitSha: string;
  try {
    commitSha = await git.resolveRef({ fs, dir, ref });
  } catch (cause) {
    // No resolvable tip (missing ref / not-yet-materialized repo) means there
    // is no history to walk and so no oversized pack to build -- the ceiling is
    // moot. Let the real `createPack` handle whatever state the repo is in.
    if (
      cause instanceof Error &&
      (cause.name === "NotFoundError" ||
        cause.message.includes("Could not find"))
    ) {
      return;
    }
    throw cause;
  }
  if (commitSha === sinceTip) return;
  const seen = new Set<string>();
  let current: string | null = commitSha;
  let commitCount = 0;
  while (current !== null && current !== sinceTip) {
    for (const oid of await collectReachableObjects(dir, current)) {
      seen.add(oid);
    }
    commitCount += 1;
    if (commitCount > limits.maxCommits || seen.size > limits.maxObjects) {
      logger.warn`workflow-run pack push ceiling exceeded for ${repoIdLabel}/${ref} (${commitSha}): ${String(commitCount)} commits / ${String(seen.size)} objects over limit ${String(limits.maxCommits)}/${String(limits.maxObjects)}; failing run`;
      throw new WorkflowRunPackTooLargeError({
        repoId: repoIdLabel,
        ref,
        commitCount,
        objectCount: seen.size,
        limits,
      });
    }
    const { commit } = await git.readCommit({ fs, dir, oid: current });
    const parent = commit.parent[0];
    current = parent ?? null;
  }
}

export type WorkflowRunPackClient = {
  /**
   * Build a pack of the workflow-run repo at `ref` and ship it to the
   * hub. Resolves on the hub's `repo.pack.ack`; rejects on
   * `repo.pack.reject`, on a disconnect that cancels the in-flight
   * transfer, or on a substrate-side `createPack` failure. The push
   * failure shape is intentionally loud per the project's
   * defensive-coding rule.
   */
  push(opts: {
    agentAddress: string;
    repoId: RepoId;
    ref: string;
  }): Promise<void>;
};

export type CreateWorkflowRunPackClientOpts = {
  substrate: RepoStore;
  hubLink: Pick<HubLink, "pushWorkflowRunPack">;
  /**
   * WORKBENCH-LOCAL (CL-2340): safety ceiling on a single pack's reachable
   * objects/commits. Defaults to the generous module constants when omitted;
   * the sidecar boot path threads in the env-resolved values.
   */
  limits?: WorkflowRunPackLimits;
};

export function createWorkflowRunPackClient(
  opts: CreateWorkflowRunPackClientOpts,
): WorkflowRunPackClient {
  const { substrate, hubLink } = opts;
  // WORKBENCH-LOCAL (CL-2340): pack size ceiling for the pre-flight below.
  const limits: WorkflowRunPackLimits = opts.limits ?? {
    maxCommits: DEFAULT_WORKFLOW_RUN_PACK_MAX_COMMITS,
    maxObjects: DEFAULT_WORKFLOW_RUN_PACK_MAX_OBJECTS,
  };

  // Shadow of the substrate's shipped-tip cursor, keyed by `(repoId.id, ref)`.
  // This client is the SOLE caller of `commitPackedTip` for the workflow-run
  // kind, so its own record of "the last commitSha I acked" cannot drift from
  // the substrate cursor. It exists to answer one question `createPack` cannot
  // answer to its caller: is the current ref tip already shipped? When the tip
  // equals the last acked sha there is nothing un-acked to ship, and building
  // a pack would produce an empty delta whose declared tip is not in the pack
  // -- which the hub rejects as `sha_mismatch`. Skipping the wire send in that
  // case is what makes a re-drive of an already-shipped tip a clean no-op
  // rather than a spurious rejection. The reconnect re-drive path
  // (`notifyAddressRoutable`) can legitimately fire for a slot whose commits
  // already landed on an earlier attempt, so this guard is load-bearing.
  const lastAckedSha = new Map<string, string>();
  function ackKey(repoId: RepoId, ref: string): string {
    return `${repoId.id}/${ref}`;
  }

  return {
    async push({ agentAddress, repoId, ref }) {
      if (repoId.kind !== "workflow-run") {
        throw new Error(
          `workflow-run pack client: repoId.kind must be "workflow-run", got ${JSON.stringify(repoId.kind)}`,
        );
      }
      const principal: WorkflowRunSupervisorPrincipal = {
        kind: "supervisor",
        deploymentId: repoId.id,
      };
      // Nothing to ship when the local tip is already the last acked tip:
      // the run's commits landed on a prior push. Return without a wire send
      // so a re-drive of an already-shipped tip is a clean no-op instead of
      // an empty-delta pack the hub rejects.
      const tip = await substrate.resolveRef(principal, repoId, ref);
      if (tip !== null && tip === lastAckedSha.get(ackKey(repoId, ref))) {
        return;
      }
      // WORKBENCH-LOCAL (CL-2340): pre-flight the delta size BEFORE
      // `createPack` builds the one-shot packfile, so a wedged run's un-acked
      // delta trips the safety ceiling and fails just that run instead of
      // OOM-ing the shared sidecar. Walks from `tip` back to this client's
      // last-acked cursor — the same base `createPack` packs from.
      await assertDeltaWithinCeiling(
        substrate.getRepoDir(repoId),
        ref,
        lastAckedSha.get(ackKey(repoId, ref)) ?? null,
        limits,
        repoId.id,
      );
      const { pack, commitSha } = await substrate.createPack(
        principal,
        repoId,
        ref,
      );
      await hubLink.pushWorkflowRunPack({
        agentAddress,
        repoId,
        pack,
        ref,
        commitSha,
      });
      // `pushWorkflowRunPack` resolves only on the hub's
      // `repo.pack.ack` and rejects on a reject or a reconnect that
      // cancels the transfer. Advancing the substrate's shipped-tip
      // cursor here — after the ack, never at build time — is what
      // lets a cancelled transfer be re-shipped: a rejected push throws
      // before this line, so the cursor stays put and the next
      // `createPack` re-includes the un-acked commits.
      substrate.commitPackedTip(repoId, ref, commitSha);
      lastAckedSha.set(ackKey(repoId, ref), commitSha);
    },
  };
}

// WORKBENCH-LOCAL (CL-4184): a workflow-run repo commits to TWO refs, each
// pushed through its own independent pack-push slot (keyed by `(repoId,
// ref)` — see `slotKey` above): `refs/heads/main` carries the run event log
// (`writeTreePreservingPrefix`) and `refs/heads/events` carries the
// claim-check inbox/processing/consumed subtree (`writeTreeDelta`, via
// interchange's `enqueueInbox` / `dequeueToProcessing` / `markConsumed` /
// `replayProcessingToInbox` in `workflow-run-kind.ts`). `refs/heads/events`
// is NOT exported by interchange — this literal is duck-typed from its
// private `claimCheckCommitRef()` and MUST be re-verified on every pin bump.
export const WORKFLOW_RUN_MAIN_REF = "refs/heads/main";
export const WORKFLOW_RUN_CLAIM_CHECK_REF = "refs/heads/events";

/**
 * WORKBENCH-LOCAL (CL-4184): the CL-2340 teardown drain barrier
 * (`teardownDeployment` in `workflow-host-wiring.ts`) awaits this before
 * reclaiming the deployment's local repo directory, so that no un-acked
 * pack push races the directory deletion. Draining only `refs/heads/main`
 * (the pre-CL-4184 behavior) left `refs/heads/events` un-drained: an
 * in-flight or failed-and-latched push on the claim-check ref could lose
 * the last `markConsumed` commit, so a cold relaunch rehydrates the
 * claim-check subtree from a stale hub copy where the just-answered mail
 * still sits in `processing/`. The next spawn's `replayProcessingToInbox`
 * then re-admits it to `inbox/` and the dispatch loop genuinely
 * re-dispatches it — a duplicate assistant reply for an already-completed
 * turn, with no `workflow_run_record` row (the replay bypasses the hub's
 * `/start` seeding). Draining BOTH refs closes that window: teardown can no
 * longer proceed to reclaim the repo dir while the claim-check ref still has
 * an outstanding push.
 */
export function createWorkflowRunPushDrain(
  store: Pick<WorkflowRunPackPushingRepoStore, "flushWorkflowRunPushes">,
): (deploymentId: string) => Promise<void> {
  return async (deploymentId: string): Promise<void> => {
    const repoId: RepoId = { kind: "workflow-run", id: deploymentId };
    const results = await Promise.allSettled([
      store.flushWorkflowRunPushes(repoId, WORKFLOW_RUN_MAIN_REF),
      store.flushWorkflowRunPushes(repoId, WORKFLOW_RUN_CLAIM_CHECK_REF),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  };
}

/**
 * Mapping registry the boot-edge substrate facade consults to resolve
 * `repoId.id` (the workflow-run deploymentId, which the deploy router
 * derives by slugging the agent's mail address) back into the
 * agentAddress carried on every outbound pack frame. Populated by the
 * deploy router as each `agent.deploy` frame lands.
 */
export type DeploymentAddressRegistry = {
  record(deploymentId: string, agentAddress: string): void;
  resolve(deploymentId: string): string | null;
  unregister(deploymentId: string): void;
};

export function createDeploymentAddressRegistry(): DeploymentAddressRegistry {
  const table = new Map<string, string>();
  return {
    record(deploymentId, agentAddress) {
      table.set(deploymentId, agentAddress);
    },
    resolve(deploymentId) {
      return table.get(deploymentId) ?? null;
    },
    unregister(deploymentId) {
      table.delete(deploymentId);
    },
  };
}

/**
 * Handler the multi-step deploy router installs on the
 * `MultistepMailRouter` after a supervisor's `spawn` succeeds. The
 * handler hands a delivered inbound mail off to the per-deployment
 * supervisor's `routeInbound`, which dispatches into the workflow-host
 * mail-bus the multi-step child's `awaitSignal` subscribes against.
 */
export type MultistepMailHandler = (message: Uint8Array) => void;

/**
 * Per-deployment-address mail handler registry the sidecar hub-link
 * consults before falling back to `transport.deliver`. The multi-step
 * deploy router registers a handler against the deployment's mail
 * address after `wired.supervisor.spawn` succeeds, so an inbound
 * `mail.inbound` frame for that address dispatches into the
 * supervisor's mail-bus subscription rather than the
 * never-provisioned-for-this-address transport mailbox.
 *
 * The registry is owned at the sidecar's host layer (not inside the
 * workflow-host library) because the routing decision is between
 * "legacy single-agent path" and "supervisor mail-bus path" -- two
 * concrete sidecar host concerns. The workflow-host package stays
 * agnostic to which transport surface its mail-bus rides on.
 */
export type MultistepMailRouter = {
  register(address: string, handler: MultistepMailHandler): void;
  unregister(address: string): void;
  tryRoute(address: string, message: Uint8Array): boolean;
};

export function createMultistepMailRouter(): MultistepMailRouter {
  const handlers = new Map<string, MultistepMailHandler>();
  return {
    register(address, handler) {
      handlers.set(address, handler);
    },
    unregister(address) {
      handlers.delete(address);
    },
    tryRoute(address, message) {
      const handler = handlers.get(address);
      if (handler === undefined) return false;
      handler(message);
      return true;
    },
  };
}

/**
 * Per-deployment signal-delivery handler the multi-step deploy router
 * installs against the `MultistepSignalRouter` after a supervisor's
 * `spawn` succeeds. The handler hands the signal off to the supervisor's
 * `deliverSignal`, which sends a `signal.deliver` control IPC frame to
 * the workflow-process child. Routing every workflow-run signal through
 * the child keeps the workflow-run repo's single-writer invariant
 * intact -- the child is the only writer of `runs/<runId>/events/` on
 * the sidecar side, so the pack-push pipeline that propagates the
 * commit to the hub never races against a concurrent host-side write.
 */
export type MultistepSignalHandler = (args: {
  runId: string;
  signalName: string;
  signalId: string;
  payload: unknown;
}) => Promise<void>;

/**
 * Per-deployment-address signal handler registry the sidecar hub-link
 * consults on every inbound `signal.deliver` frame. The deploy router
 * registers a handler against the deployment's mail address after
 * `wired.supervisor.spawn` succeeds, for single-step and multi-step
 * deployments alike; the handler dispatches the signal into the
 * supervisor's `deliverSignal`.
 *
 * The registry lives at the sidecar's host layer (not inside the
 * workflow-host library) for the same boundary reason as
 * `MultistepMailRouter`: the routing decision is a concrete sidecar
 * host concern, and the workflow-host package stays agnostic to which
 * transport surface its supervisor handle rides on.
 */
export type MultistepSignalRouter = {
  register(address: string, handler: MultistepSignalHandler): void;
  unregister(address: string): void;
  tryRoute(frame: {
    type: "signal.deliver";
    agentAddress: string;
    runId: string;
    signalName: string;
    signalId: string;
    payload: unknown;
  }): Promise<boolean>;
};

export function createMultistepSignalRouter(): MultistepSignalRouter {
  const handlers = new Map<string, MultistepSignalHandler>();
  return {
    register(address, handler) {
      handlers.set(address, handler);
    },
    unregister(address) {
      handlers.delete(address);
    },
    async tryRoute(frame) {
      const handler = handlers.get(frame.agentAddress);
      if (handler === undefined) return false;
      await handler({
        runId: frame.runId,
        signalName: frame.signalName,
        signalId: frame.signalId,
        payload: frame.payload,
      });
      return true;
    },
  };
}

/**
 * Per-deployment drain handler the multi-step deploy router installs
 * against the `MultistepDrainRouter` after a supervisor's `spawn`
 * succeeds. The handler hands the drain opts off to the supervisor's
 * `drain`, which sends a `drain` control IPC frame to the
 * workflow-process child and arms one `drainTimeout` accumulator per
 * in-flight run. Cancel-mode in-flight steps abort as the child's
 * controller signal flips; wait-mode steps continue. Each accumulator
 * commits a signed `CancelRequested{origin: "supervisor-drain"}`
 * against the workflow-run repo when the deadline expires.
 */
export type MultistepDrainHandler = (args: {
  deadlineMs: number;
}) => Promise<void>;

/**
 * Per-deployment-address drain handler registry the sidecar hub-link
 * consults on every inbound `drain.deliver` frame. The deploy router
 * registers a handler against the deployment's mail address after
 * `wired.supervisor.spawn` succeeds, for single-step and multi-step
 * deployments alike; the handler dispatches into the supervisor's
 * `drain`.
 *
 * The registry lives at the sidecar's host layer (not inside the
 * workflow-host library) for the same boundary reason as
 * `MultistepMailRouter` / `MultistepSignalRouter`: the routing decision
 * is a concrete sidecar host concern, and the workflow-host package
 * stays agnostic to which transport surface its supervisor handle
 * rides on.
 */
export type MultistepDrainRouter = {
  register(address: string, handler: MultistepDrainHandler): void;
  unregister(address: string): void;
  tryRoute(frame: {
    type: "drain.deliver";
    agentAddress: string;
    deadlineMs: number;
  }): Promise<boolean>;
};

export function createMultistepDrainRouter(): MultistepDrainRouter {
  const handlers = new Map<string, MultistepDrainHandler>();
  return {
    register(address, handler) {
      handlers.set(address, handler);
    },
    unregister(address) {
      handlers.delete(address);
    },
    async tryRoute(frame) {
      const handler = handlers.get(frame.agentAddress);
      if (handler === undefined) return false;
      await handler({ deadlineMs: frame.deadlineMs });
      return true;
    },
  };
}

/**
 * Per-deployment sources-rotation handler the deploy router installs
 * against the `MultistepSourcesRouter` after a supervisor's `spawn`
 * succeeds -- but ONLY for a single-step (warm launched-agent)
 * deployment. The handler hands the rotated list off to the supervisor's
 * `deliverSources`, which sends a `sources-updated` control IPC frame to
 * the workflow-process child, where the warm agent's live sources are
 * swapped in place. A multi-step deployment has no single warm agent to
 * rotate, so the router registers no handler for it and an inbound
 * `sources.update` for a multi-step address is unrouted.
 */
export type MultistepSourcesHandler = (args: {
  sources: InferenceSource[];
  defaultSource: string;
}) => Promise<void>;

/**
 * Per-deployment-address sources-rotation handler registry. Only a
 * single-step warm deployment registers a handler (after
 * `wired.supervisor.spawn` succeeds); a multi-step deployment never
 * does, so `tryRoute` resolves a rotation only for a registered
 * single-step address and returns `false` for any other.
 *
 * The registry lives at the sidecar's host layer for the same boundary
 * reason as the mail/signal/drain routers: the routing decision is a
 * concrete sidecar host concern, and the workflow-host package stays
 * agnostic to which transport surface its supervisor handle rides on.
 */
export type MultistepSourcesRouter = {
  register(address: string, handler: MultistepSourcesHandler): void;
  unregister(address: string): void;
  tryRoute(frame: {
    type: "sources.update";
    agentAddress: string;
    sources: InferenceSource[];
    defaultSource: string;
  }): Promise<boolean>;
};

export function createMultistepSourcesRouter(): MultistepSourcesRouter {
  const handlers = new Map<string, MultistepSourcesHandler>();
  return {
    register(address, handler) {
      handlers.set(address, handler);
    },
    unregister(address) {
      handlers.delete(address);
    },
    async tryRoute(frame) {
      const handler = handlers.get(frame.agentAddress);
      // Registration check first: an unregistered (multi-step or torn-down)
      // address is unrouted -- reported as `false`, its payload never
      // inspected, because it would not be acted on regardless.
      if (handler === undefined) return false;
      // Validate the rotation BEFORE dispatch. This is the only inbound
      // router that validates its frame, and deliberately so: a bad list
      // (duplicate ids, or a default that is not the head element) would
      // reach the child's control-channel receiver and crash it on
      // `SourcesUpdatedData`'s narrow -- the sources-updated frame is the
      // only inbound frame carrying a crash-on-invalid narrow downstream,
      // and the only one that is request/ack. Rejecting here throws, and
      // the hub-link turns the throw into a truthful `session.error`
      // instead of acking and detonating the child.
      const validated = SourcesUpdatedData({
        sources: frame.sources,
        defaultSource: frame.defaultSource,
      });
      if (validated instanceof type.errors) {
        throw new Error(validated.summary);
      }
      await handler({
        sources: frame.sources,
        defaultSource: frame.defaultSource,
      });
      return true;
    },
  };
}

/**
 * Boot-edge facade around the substrate-shaped `RepoStore`. Forwards
 * every method to the underlying store; intercepts the
 * `writeTreePreservingPrefix` return path so a successful write
 * against a `workflow-run` repo schedules a workflow-run pack push.
 * Writes against any other `repoId.kind` (today, only `agent-state`
 * via the deploy-applier path) flow through unchanged.
 *
 * Pack-push coalescing: the facade returns from
 * `writeTreePreservingPrefix` as soon as the LOCAL commit lands and
 * schedules an asynchronous pack push for `(repoId.id, ref)`. At
 * most one push per (repoId, ref) is in flight at a time. Writes
 * that arrive while a push is in flight are NOT enqueued as
 * additional pushes; instead they mark the slot as "dirty", and the
 * loop runs one more push after the current one settles. This means
 * a burst of N writes against the same ref produces at most 2
 * pushes (the one already running when the burst starts, plus one
 * more for everything that arrived during it), rather than N
 * serial round-trips' worth of hub-ack latency. The push body
 * captures the current local ref tip at the moment it runs, so the
 * single pack it builds covers every commit landed since the prior
 * ACKED tip -- the substrate's incremental `createPack` walks the
 * chain from the cursor `commitPackedTip` last committed on an ack
 * forward, so the receiver still sees every commit transition.
 *
 * Single-writer + FIFO correctness: the underlying substrate
 * serialises local writes via `withRepoLock`, so commits land on
 * disk in submission order. The hub's `receivePack` validates each
 * commit's parent against its existing-commits set; as long as the
 * pack carries the full chain from prior acked tip to current tip,
 * every intermediate commit is validated by the receiver. Coalescing
 * multiple local commits into one network push therefore preserves
 * the receive-time CAS invariant while collapsing N hub round-trips
 * into 1.
 *
 * Reconnect-safe re-shipping: the substrate advances its shipped-tip
 * cursor on the ack (`push` calls `commitPackedTip` only after
 * `pushWorkflowRunPack` resolves), never at build time. A transfer a
 * reconnect cancels before its ack therefore leaves the cursor where
 * it was, so the retry loop's next `createPack` re-includes the
 * un-acked commits and the receiver gets a self-consistent chain
 * rather than a pack whose base commit it never received.
 *
 * Failure surfacing: a failed push latches its error on the
 * per-(repoId, ref) slot's `lastError` field. The next call to
 * `writeTreePreservingPrefix` on that (repoId, ref) re-throws the
 * latched error before doing its own work, keeping failures loud
 * rather than swallowed by the fire-and-forget pipeline. The
 * defensive-coding rule says errors must surface; this is how they
 * surface from a coalescing writer.
 *
 * Flush: callers that need a hub-visible barrier (shutdown,
 * integration tests that read hub-side state) call
 * `flushWorkflowRunPushes(repoId, ref)` to await the per-(repoId,
 * ref) slot to drain (both the in-flight push and any follow-up
 * triggered by writes that arrived during it).
 */
export type WorkflowRunPackPushingRepoStoreOpts = {
  underlying: RepoStore;
  packClient: WorkflowRunPackClient;
  registry: DeploymentAddressRegistry;
};

/**
 * The wrapped store plus a side-channel API for waiting on the
 * per-(repoId.id, ref) pack-push pipeline to drain. The `RepoStore`
 * shape is unchanged so call sites that consume `RepoStore` keep
 * working; `flushWorkflowRunPushes` is opt-in for code that
 * genuinely needs hub-side visibility (shutdown, integration tests,
 * end-to-end benchmarks). Call sites that don't need it pay zero
 * cost.
 */
export type WorkflowRunPackPushingRepoStore = RepoStore & {
  /**
   * Await the pack-push pipeline for `(repoId.id, ref)` to drain.
   * Resolves once no push is in flight and no follow-up push is
   * pending; rejects if the most recent push failed (the same
   * latched error the next `writeTreePreservingPrefix` call would
   * surface).
   */
  flushWorkflowRunPushes: (repoId: RepoId, ref: string) => Promise<void>;
  /**
   * Re-drive any workflow-run push for `agentAddress` that a disconnect
   * cancelled. Called when the hub-link observes the deployment address
   * become routable again after a reconnect challenge. For each slot bound
   * to `agentAddress` whose last push attempt failed (its `lastError` is
   * latched), it re-arms the coalescing loop so a fresh `createPack` re-ships
   * the un-acked commits -- the liveness path a synchronous single-step run
   * lacks, because it has no later local write to re-set `dirty`.
   *
   * A re-ship that fails again re-latches without self-retrying, so a
   * genuinely unrecoverable failure still surfaces loudly on the next local
   * write rather than spinning. It is gated on the address being routable
   * again (the caller only fires post-challenge) so the re-ship cannot race
   * ahead of the hub re-routing the address.
   */
  notifyAddressRoutable: (agentAddress: string) => void;
  /**
   * Block workflow-run pushes for `agentAddress` until the next
   * `notifyAddressRoutable`. Called when the hub-link observes its WS drop:
   * the address's hub route is gone until the reconnect challenge re-proves
   * ownership, so a push shipped in the interim is dropped by the hub as
   * "unrouted". Holding the push at the block -- rather than shipping and
   * failing -- is what lets the reconnect re-ship wait for the challenge.
   */
  markAddressUnroutable: (agentAddress: string) => void;
};

export function createWorkflowRunPackPushingRepoStore(
  opts: WorkflowRunPackPushingRepoStoreOpts,
): WorkflowRunPackPushingRepoStore {
  const { underlying, packClient, registry } = opts;

  type Slot = {
    agentAddress: string;
    repoId: RepoId;
    ref: string;
    inFlight: Promise<void> | null;
    dirty: boolean;
    lastError: Error | null;
    // WORKBENCH-LOCAL (CL-2340): sticky TERMINAL error, distinct from the
    // retryable `lastError`. Set when a push trips the size ceiling
    // (WorkflowRunPackTooLargeError) — an unrecoverable state: the un-acked
    // delta only grows, so retrying re-walks the same growing range and
    // re-throws forever. Unlike `lastError`, this is never cleared by a read:
    // once set, every subsequent workflow-run write for this slot re-throws it,
    // so the wedged run stops appending events (bounding the delta) and fails
    // loudly rather than silently oscillating (write fails → retry succeeds and
    // grows the delta → next push re-throws) with only a Sentry-invisible WARN.
    terminalError: Error | null;
    settled: (() => void)[];
  };
  const slots = new Map<string, Slot>();
  function slotKey(repoId: RepoId, ref: string): string {
    return `${repoId.kind}/${repoId.id}/${ref}`;
  }

  // Addresses whose hub route was dropped and has not been re-established by a
  // reconnect challenge. Absent means routable -- the steady state, and the
  // first-connect state (a deployment routes via its `agent.deploy`, not a
  // challenge, so it is never blocked before its first push). An address is
  // added on `markAddressUnroutable` (WS disconnect) and removed on
  // `notifyAddressRoutable` (challenge passed). A push for a blocked address
  // is held: the coalescing loop pauses with `dirty` still set rather than
  // shipping to a hub that has not yet re-routed the address -- which is what
  // makes the reconnect re-ship wait for the challenge instead of racing
  // ahead of it and being dropped as "unrouted".
  const blockedAddresses = new Set<string>();

  function notifySettled(slot: Slot): void {
    const callbacks = slot.settled;
    slot.settled = [];
    for (const cb of callbacks) cb();
  }

  function startLoop(slot: Slot, repoId: RepoId, ref: string): void {
    if (slot.inFlight !== null) return;
    // Hold the push while the address is not routable (dropped, awaiting the
    // reconnect challenge). Leave `dirty` set and start no loop: the loop
    // resumes when `notifyAddressRoutable` clears the block and re-arms it.
    // Shipping now would race ahead of the hub re-routing the address, and
    // the frames would be dropped as "unrouted".
    if (blockedAddresses.has(slot.agentAddress)) return;
    slot.inFlight = (async () => {
      while (slot.dirty) {
        // Re-check routability each iteration: a disconnect mid-drain must
        // pause the loop rather than push into a severed link. Leave `dirty`
        // set so the post-challenge resume re-ships.
        if (blockedAddresses.has(slot.agentAddress)) break;
        slot.dirty = false;
        try {
          await packClient.push({
            agentAddress: slot.agentAddress,
            repoId,
            ref,
          });
          slot.lastError = null;
        } catch (cause) {
          // WORKBENCH-LOCAL (CL-2340): the size-ceiling breach is TERMINAL, not
          // retryable. Log at ERROR (the sink forwards only error/fatal to
          // Sentry — a WARN here would black the run out invisibly) and latch it
          // as the sticky terminal error so every subsequent write for this run
          // re-throws it: the run stops growing its un-shippable delta and fails
          // loudly instead of silently churning. Stop the loop (leave `dirty`
          // false) — re-running the push would only re-walk the same oversized
          // range and re-throw.
          if (cause instanceof WorkflowRunPackTooLargeError) {
            logger.error`workflow-run pack push exceeded the size ceiling for deployment ${repoId.id} (${slot.agentAddress}); failing the run: ${cause.message}`;
            slot.terminalError = cause;
            break;
          }
          // A receiver `path_violation` is a deterministic content rejection
          // (the hub's tree validator refused the pack); re-shipping the
          // identical delta on the next event append or reconnect re-drive
          // fails identically forever. Latch it terminal like the size
          // ceiling so this slot stops generating doomed traffic for the
          // process lifetime. The substring couples to the pack-transport
          // reject message — see the pin-bump seam note in docs/VENDORED.md.
          if (
            cause instanceof Error &&
            cause.message.includes("path_violation")
          ) {
            logger.error`workflow-run pack push permanently rejected for deployment ${repoId.id} (${slot.agentAddress}); latching terminal: ${cause.message}`;
            slot.terminalError = cause;
            break;
          }
          const msg = cause instanceof Error ? cause.message : String(cause);
          logger.warn`workflow-run pack push failed for deployment ${repoId.id} (${slot.agentAddress}): ${msg}`;
          slot.lastError =
            cause instanceof Error ? cause : new Error(String(cause));
        }
      }
      slot.inFlight = null;
      notifySettled(slot);
    })();
  }

  function schedulePush(
    agentAddress: string,
    repoId: RepoId,
    ref: string,
  ): void {
    const key = slotKey(repoId, ref);
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        agentAddress,
        repoId,
        ref,
        inFlight: null,
        dirty: false,
        lastError: null,
        terminalError: null,
        settled: [],
      };
      slots.set(key, slot);
    } else {
      // The agentAddress is derived from a stable per-deployment
      // mapping; refreshing it on every call keeps the slot in sync
      // if the registry ever re-resolves the same deploymentId to
      // a different address (today it does not, but the contract is
      // "look up at push time", not "cache forever").
      slot.agentAddress = agentAddress;
    }
    slot.dirty = true;
    startLoop(slot, repoId, ref);
  }

  function takeLatchedError(repoId: RepoId, ref: string): Error | null {
    const slot = slots.get(slotKey(repoId, ref));
    if (slot === undefined) return null;
    const err = slot.lastError;
    if (err !== null) slot.lastError = null;
    return err;
  }

  // WORKBENCH-LOCAL (CL-2340): read the sticky terminal error WITHOUT clearing
  // it. A run whose delta tripped the size ceiling is unrecoverable, so every
  // subsequent write must keep failing (bounding the un-shippable delta) rather
  // than clearing the error and letting the run grow again.
  function peekTerminalError(repoId: RepoId, ref: string): Error | null {
    return slots.get(slotKey(repoId, ref))?.terminalError ?? null;
  }

  function markAddressUnroutable(agentAddress: string): void {
    // The hub route for this address just dropped (WS disconnect). Block its
    // pushes until the reconnect challenge re-routes it. A push already
    // in-flight when the link dropped rejects through `packSender.cancelAll`
    // and latches its error; the block stops the coalescing loop from
    // immediately re-shipping on the fresh (not-yet-challenged) connection.
    blockedAddresses.add(agentAddress);
  }

  function notifyAddressRoutable(agentAddress: string): void {
    // The reconnect challenge re-routed this address on the hub. Clear the
    // block and re-drive so a push the disconnect cancelled -- or one held
    // while the block was up -- ships now. This is the liveness path a
    // synchronous single-step run lacks: with all its events in one batch it
    // has no later local write to re-arm the coalescing loop, so the drop
    // would otherwise strand it forever.
    blockedAddresses.delete(agentAddress);
    for (const slot of slots.values()) {
      if (slot.agentAddress !== agentAddress) continue;
      // Re-drive a slot that has pending work (`dirty`, e.g. a push held at
      // the block) OR whose last attempt failed (`lastError` latched by the
      // disconnect-cancel). A slot that is clean and already acked
      // (`!dirty && lastError === null`) has nothing un-shipped -- the
      // `packClient.push` empty-delta guard would skip it anyway, but not
      // re-arming it avoids a pointless loop spin. Re-arming `dirty` and
      // restarting is safe against double-ship: `startLoop` no-ops when a
      // push is already in flight, and the per-(repoId, ref) serialization in
      // the hub-link's `pushWorkflowRunPack` prevents overlapping transfers.
      // WORKBENCH-LOCAL (CL-2340): never re-drive a terminally-failed run (size
      // ceiling). Retrying only re-walks the same oversized delta and re-throws;
      // the run is already failed loudly.
      if (slot.terminalError !== null) continue;
      if (!slot.dirty && slot.lastError === null) continue;
      slot.dirty = true;
      startLoop(slot, slot.repoId, slot.ref);
    }
  }

  async function flushWorkflowRunPushes(
    repoId: RepoId,
    ref: string,
  ): Promise<void> {
    const slot = slots.get(slotKey(repoId, ref));
    if (slot === undefined) return;
    // WORKBENCH-LOCAL (CL-2340): a terminally-failed run (size ceiling) surfaces
    // its sticky error to any flush too, WITHOUT clearing it — the run stays
    // failed. Checked before the drain wait: a terminal slot's loop has already
    // stopped, so there is nothing to await.
    if (slot.terminalError !== null) {
      throw slot.terminalError;
    }
    if (slot.inFlight === null && !slot.dirty) {
      if (slot.lastError !== null) {
        const err = slot.lastError;
        slot.lastError = null;
        throw err;
      }
      return;
    }
    await new Promise<void>((resolve) => {
      slot.settled.push(resolve);
    });
    if (slot.terminalError !== null) {
      throw slot.terminalError;
    }
    if (slot.lastError !== null) {
      const err = slot.lastError;
      slot.lastError = null;
      throw err;
    }
  }

  const wrapped: WorkflowRunPackPushingRepoStore = {
    initRepo: underlying.initRepo.bind(underlying),
    writeTree: underlying.writeTree.bind(underlying),
    receivePack: underlying.receivePack.bind(underlying),
    createPack: underlying.createPack.bind(underlying),
    commitPackedTip: underlying.commitPackedTip.bind(underlying),
    resolveRef: underlying.resolveRef.bind(underlying),
    listRefs: underlying.listRefs.bind(underlying),
    resolveHead: underlying.resolveHead.bind(underlying),
    getRepoDir: underlying.getRepoDir.bind(underlying),
    openCommittedReads: underlying.openCommittedReads.bind(underlying),
    openCommittedReadsAtCommit:
      underlying.openCommittedReadsAtCommit.bind(underlying),
    subscribe: underlying.subscribe.bind(underlying),
    flushWorkflowRunPushes,
    notifyAddressRoutable,
    markAddressUnroutable,
    async writeTreePreservingPrefix(principal, repoId, ref, args) {
      if (repoId.kind === "workflow-run") {
        const terminal = peekTerminalError(repoId, ref);
        if (terminal !== null) {
          throw terminal;
        }
        const latched = takeLatchedError(repoId, ref);
        if (latched !== null) {
          throw latched;
        }
      }
      const result = await underlying.writeTreePreservingPrefix(
        principal,
        repoId,
        ref,
        args,
      );
      if (repoId.kind !== "workflow-run") {
        return result;
      }
      const agentAddress = registry.resolve(repoId.id);
      if (agentAddress === null) {
        throw new Error(
          `workflow-run pack push: no agent address registered for deployment ${repoId.id}; the deploy router must record the mapping before the supervisor commits run events`,
        );
      }
      schedulePush(agentAddress, repoId, ref);
      return result;
    },
    async writeTreeDelta(principal, repoId, ref, args) {
      if (repoId.kind === "workflow-run") {
        const terminal = peekTerminalError(repoId, ref);
        if (terminal !== null) {
          throw terminal;
        }
        const latched = takeLatchedError(repoId, ref);
        if (latched !== null) {
          throw latched;
        }
      }
      const result = await underlying.writeTreeDelta(
        principal,
        repoId,
        ref,
        args,
      );
      if (repoId.kind !== "workflow-run") {
        return result;
      }
      const agentAddress = registry.resolve(repoId.id);
      if (agentAddress === null) {
        throw new Error(
          `workflow-run pack push: no agent address registered for deployment ${repoId.id}; the deploy router must record the mapping before the supervisor commits run events`,
        );
      }
      schedulePush(agentAddress, repoId, ref);
      return result;
    },
  };
  return wrapped;
}
