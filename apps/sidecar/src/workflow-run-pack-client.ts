// Sits between the boot-edge substrate facade and the hub-link's
// pushWorkflowRunPack wire surface, fired after a successful
// writeTreePreservingPrefix against a workflow-run repo.

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { SourcesUpdatedData } from "@intx/workflow-host";
import type { InferenceSource } from "@intx/types/runtime";
import { CredentialDelivery, type SenderIdentity } from "@intx/types/sidecar";
import type { RepoId, RepoStore, WorkflowRunSupervisorPrincipal } from "@intx/hub-sessions";
import type { HubLink } from "@intx/hub-agent";

const logger = getLogger(["interchange", "sidecar", "workflow-run-pack-client"]);

export type WorkflowRunPackClient = {
  /** Resolves on the hub's repo.pack.ack; rejects loud on reject, disconnect, or a substrate createPack failure. */
  push(opts: { agentAddress: string; repoId: RepoId; ref: string }): Promise<void>;
  /** Prevents a reconnect from re-sending an empty delta at the restored tip. */
  markRestored(repoId: RepoId, ref: string, commitSha: string): void;
};

export type CreateWorkflowRunPackClientOpts = {
  substrate: RepoStore;
  hubLink: Pick<HubLink, "pushWorkflowRunPack">;
};

export function createWorkflowRunPackClient(
  opts: CreateWorkflowRunPackClientOpts,
): WorkflowRunPackClient {
  const { substrate, hubLink } = opts;

  // Answers a question createPack can't: is the tip already shipped? Skips
  // the wire send when it is, since an empty-delta pack the hub rejects as
  // sha_mismatch would otherwise turn a re-drive into a spurious rejection.
  const lastAckedSha = new Map<string, string>();
  function ackKey(repoId: RepoId, ref: string): string {
    return `${repoId.id}/${ref}`;
  }

  return {
    markRestored(repoId, ref, commitSha) {
      if (repoId.kind !== "workflow-run") {
        throw new Error(
          `workflow-run pack client: restored repoId.kind must be "workflow-run", got ${JSON.stringify(repoId.kind)}`,
        );
      }
      substrate.commitPackedTip(repoId, ref, commitSha);
      lastAckedSha.set(ackKey(repoId, ref), commitSha);
    },
    async push({ agentAddress, repoId, ref }) {
      if (repoId.kind !== "workflow-run") {
        throw new Error(
          `workflow-run pack client: repoId.kind must be "workflow-run", got ${JSON.stringify(repoId.kind)}`,
        );
      }
      const principal: WorkflowRunSupervisorPrincipal = {
        kind: "supervisor",
        anchorRunId: repoId.id,
      };
      // Nothing to ship if the run's commits already landed on a prior push.
      const tip = await substrate.resolveRef(principal, repoId, ref);
      if (tip !== null && tip === lastAckedSha.get(ackKey(repoId, ref))) {
        return;
      }
      const { pack, commitSha } = await substrate.createPack(principal, repoId, ref);
      await hubLink.pushWorkflowRunPack({
        agentAddress,
        repoId,
        pack,
        ref,
        commitSha,
      });
      // Advanced only after the ack (never at build time) so a cancelled
      // transfer leaves the cursor put and gets re-shipped on retry.
      substrate.commitPackedTip(repoId, ref, commitSha);
      lastAckedSha.set(ackKey(repoId, ref), commitSha);
    },
  };
}

/** Resolves repoId.id (the workflow-run runId) back into the agentAddress carried on outbound pack frames. */
export type DeploymentAddressRegistry = {
  record(runId: string, agentAddress: string): void;
  resolve(runId: string): string | null;
  unregister(runId: string): void;
};

export function createDeploymentAddressRegistry(): DeploymentAddressRegistry {
  const table = new Map<string, string>();
  return {
    record(runId, agentAddress) {
      table.set(runId, agentAddress);
    },
    resolve(runId) {
      return table.get(runId) ?? null;
    },
    unregister(runId) {
      table.delete(runId);
    },
  };
}

/** Dispatches into the workflow-host mail-bus the multi-step child's awaitSignal subscribes against. */
export type MultistepMailHandler = (message: Uint8Array) => Promise<void>;

/**
 * Kept at the sidecar host layer (not inside workflow-host) since the
 * routing decision — legacy single-agent path vs supervisor mail-bus —
 * is a concrete host concern the portable package stays agnostic to.
 */
export type MultistepMailRouter = {
  register(address: string, handler: MultistepMailHandler): void;
  unregister(address: string): void;
  /** Returns null when unregistered (caller logs and drops, sends no ack). */
  tryRoute(address: string, message: Uint8Array): Promise<void> | null;
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
      if (handler === undefined) return null;
      return handler(message);
    },
  };
}

/** Routing every signal through the child preserves the workflow-run repo's single-writer invariant. */
export type MultistepSignalHandler = (args: {
  runId: string;
  signalName: string;
  signalId: string;
  payload: unknown;
}) => Promise<void>;

// Same boundary reason as MultistepMailRouter.
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
 * The write is awaited so FIFO completion means grants are durable before
 * the next frame processes. senderIdentities are cached before the write so
 * a durable grant is never missing the key to verify the sender's mail.
 */
export type MultistepGrantsHandler = (args: {
  runId: string;
  stepGrants: readonly unknown[];
  senderIdentities?: readonly SenderIdentity[];
}) => Promise<void>;

// Same boundary reason as MultistepMailRouter / MultistepSignalRouter.
export type MultistepGrantsRouter = {
  register(address: string, handler: MultistepGrantsHandler): void;
  unregister(address: string): void;
  tryRoute(frame: {
    type: "run.grants";
    agentAddress: string;
    runId: string;
    stepGrants: readonly unknown[];
    senderIdentities?: readonly SenderIdentity[];
  }): Promise<boolean>;
};

export function createMultistepGrantsRouter(): MultistepGrantsRouter {
  const handlers = new Map<string, MultistepGrantsHandler>();
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
        stepGrants: frame.stepGrants,
        ...(frame.senderIdentities !== undefined
          ? { senderIdentities: frame.senderIdentities }
          : {}),
      });
      return true;
    },
  };
}

/** Each drainTimeout accumulator commits a signed CancelRequested against the workflow-run repo at deadline. */
export type MultistepDrainHandler = (args: { deadlineMs: number }) => Promise<void>;

// Same boundary reason as MultistepMailRouter / MultistepSignalRouter.
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

/** Only for single-step (warm launched-agent) deployments; multi-step has no single warm agent to rotate. */
export type MultistepSourcesHandler = (args: {
  sources: InferenceSource[];
  defaultSource: string;
}) => Promise<void>;

// Same boundary reason as the mail/signal/drain routers.
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
      if (handler === undefined) return false;
      // Validated before dispatch, unlike other routers: a bad frame would
      // crash the child's control-channel receiver on SourcesUpdatedData's
      // narrow. Throwing here turns it into a session.error instead.
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
 * Unlike sources rotation, registers for any deployment: the material cell
 * is per-child. No durable persist — material never touches disk.
 */
export type MultistepCredentialsHandler = (args: {
  delivery: CredentialDelivery;
  revoke?: string[];
}) => Promise<void>;

/** Mirrors MultistepSourcesRouter: request/ack, so a throw surfaces as session.error. */
export type MultistepCredentialsRouter = {
  register(address: string, handler: MultistepCredentialsHandler): void;
  unregister(address: string): void;
  tryRoute(frame: {
    type: "credentials.update";
    agentAddress: string;
    delivery: CredentialDelivery;
    revoke?: string[];
  }): Promise<boolean>;
};

export function createMultistepCredentialsRouter(): MultistepCredentialsRouter {
  const handlers = new Map<string, MultistepCredentialsHandler>();
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
      // Validated before dispatch: a malformed delivery would crash the
      // child's control-channel receiver instead of surfacing as session.error.
      const validated = CredentialDelivery(frame.delivery);
      if (validated instanceof type.errors) {
        throw new Error(validated.summary);
      }
      await handler({
        delivery: frame.delivery,
        ...(frame.revoke !== undefined ? { revoke: frame.revoke } : {}),
      });
      return true;
    },
  };
}

/**
 * Wraps RepoStore so a successful writeTreePreservingPrefix against a
 * workflow-run repo schedules a coalesced pack push: at most one push per
 * (repoId, ref) in flight, with writes arriving mid-push marking the slot
 * dirty for one more run rather than queuing N pushes. The shipped-tip
 * cursor advances only after the hub's ack, so a reconnect-cancelled
 * transfer is re-shipped whole on the next createPack rather than leaving
 * a gap. A failed push latches on the slot and re-throws on the next write
 * to that (repoId, ref) instead of being swallowed.
 */
export type WorkflowRunPackPushingRepoStoreOpts = {
  underlying: RepoStore;
  packClient: Pick<WorkflowRunPackClient, "push">;
  registry: DeploymentAddressRegistry;
};

/** RepoStore shape is unchanged; flushWorkflowRunPushes is opt-in for callers needing hub-side visibility. */
export type WorkflowRunPackPushingRepoStore = RepoStore & {
  /** Resolves once the (repoId.id, ref) pipeline drains; rejects on the same latched error a write would surface. */
  flushWorkflowRunPushes: (repoId: RepoId, ref: string) => Promise<void>;
  /**
   * Re-arms a slot a disconnect cancelled — the liveness path a synchronous
   * single-step run lacks, since it has no later local write to re-set dirty.
   * Gated on post-reconnect so the re-ship can't race ahead of hub re-routing.
   */
  notifyAddressRoutable: (agentAddress: string) => void;
  /** Holds pushes rather than shipping-and-failing, so a WS-drop address waits for reconnect before shipping. */
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
    settled: (() => void)[];
  };
  const slots = new Map<string, Slot>();
  function slotKey(repoId: RepoId, ref: string): string {
    return `${repoId.kind}/${repoId.id}/${ref}`;
  }

  // Absent means routable. A blocked address's push holds with dirty still
  // set, rather than racing ahead of hub re-routing and being dropped.
  const blockedAddresses = new Set<string>();

  function notifySettled(slot: Slot): void {
    const callbacks = slot.settled;
    slot.settled = [];
    for (const cb of callbacks) cb();
  }

  function startLoop(slot: Slot, repoId: RepoId, ref: string): void {
    if (slot.inFlight !== null) return;
    if (blockedAddresses.has(slot.agentAddress)) return;
    slot.inFlight = (async () => {
      while (slot.dirty) {
        // Re-checked each iteration: a disconnect mid-drain must pause
        // rather than push into a severed link.
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
          const msg = cause instanceof Error ? cause.message : String(cause);
          logger.warn`workflow-run pack push failed for deployment ${repoId.id} (${slot.agentAddress}): ${msg}`;
          slot.lastError = cause instanceof Error ? cause : new Error(String(cause));
        }
      }
      slot.inFlight = null;
      notifySettled(slot);
    })();
  }

  function schedulePush(agentAddress: string, repoId: RepoId, ref: string): void {
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
        settled: [],
      };
      slots.set(key, slot);
    } else {
      // Refreshed every call, not cached: the contract is "look up at push time".
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

  function markAddressUnroutable(agentAddress: string): void {
    blockedAddresses.add(agentAddress);
  }

  function notifyAddressRoutable(agentAddress: string): void {
    blockedAddresses.delete(agentAddress);
    for (const slot of slots.values()) {
      if (slot.agentAddress !== agentAddress) continue;
      // Skip a clean, already-acked slot to avoid a pointless loop spin.
      // Re-arming is safe against double-ship: startLoop no-ops if a push
      // is already in flight.
      if (!slot.dirty && slot.lastError === null) continue;
      slot.dirty = true;
      startLoop(slot, slot.repoId, slot.ref);
    }
  }

  async function flushWorkflowRunPushes(repoId: RepoId, ref: string): Promise<void> {
    const slot = slots.get(slotKey(repoId, ref));
    if (slot === undefined) return;
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
    openCommittedReadsAtCommit: underlying.openCommittedReadsAtCommit.bind(underlying),
    subscribe: underlying.subscribe.bind(underlying),
    flushWorkflowRunPushes,
    notifyAddressRoutable,
    markAddressUnroutable,
    async writeTreePreservingPrefix(principal, repoId, ref, args) {
      if (repoId.kind === "workflow-run") {
        const latched = takeLatchedError(repoId, ref);
        if (latched !== null) {
          throw latched;
        }
      }
      const result = await underlying.writeTreePreservingPrefix(principal, repoId, ref, args);
      if (repoId.kind !== "workflow-run") {
        return result;
      }
      const agentAddress = registry.resolve(repoId.id);
      if (agentAddress === null) {
        throw new Error(
          `workflow-run pack push: no run address registered for deployment ${repoId.id}; the deploy router must record the mapping before the supervisor commits run events`,
        );
      }
      schedulePush(agentAddress, repoId, ref);
      return result;
    },
    async writeTreeDelta(principal, repoId, ref, args) {
      if (repoId.kind === "workflow-run") {
        const latched = takeLatchedError(repoId, ref);
        if (latched !== null) {
          throw latched;
        }
      }
      const result = await underlying.writeTreeDelta(principal, repoId, ref, args);
      if (repoId.kind !== "workflow-run") {
        return result;
      }
      const agentAddress = registry.resolve(repoId.id);
      if (agentAddress === null) {
        throw new Error(
          `workflow-run pack push: no run address registered for deployment ${repoId.id}; the deploy router must record the mapping before the supervisor commits run events`,
        );
      }
      schedulePush(agentAddress, repoId, ref);
      return result;
    },
  };
  return wrapped;
}
