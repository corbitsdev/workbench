// Per-deployment supervisor construction with the sidecar's bindings
// pre-wired: the hub-transport mail-bus adapter, the Ed25519 principal
// signer, the resolved `bin/workflow-child` binary, and the mail-audit
// reference derivation the supervisor stamps onto every envelope.

import { signEd25519 } from "@intx/crypto";
import type { HubTransport } from "@intx/mail-memory";
import type {
  RepoId,
  RepoStore,
  WorkflowRunSupervisorPrincipal,
} from "@intx/hub-sessions";
import {
  createWorkflowSupervisor,
  hashGrants,
  wrapHubTransportAsMailBus,
  type CredentialsSnapshot,
  type CredentialsSnapshotStep,
  type DeriveStepAddress,
  type DeriveStepRepoId,
  type DispatchTimingMark,
  type HubTransportMailBusAdapter,
  type PrincipalSigner,
  type RecyclePolicyBounds,
  type SubprocessHandle,
  type SubprocessSpawner,
  type SuspensionRegistration,
  type WorkflowSupervisor,
} from "@intx/workflow-host";

import { getLogger } from "@intx/log";

import {
  defaultSubprocessSpawner,
  SIDECAR_WORKFLOW_CHILD_BINARY,
} from "./transport";
import { readRunGrants, runGrantsPath } from "../run-grants";

const logger = getLogger(["sidecar", "workflow-host-wiring", "supervisor"]);

/**
 * Conservative default for the warm-keep recycle policy's grants-staleness
 * bound. A warm-keep child's agent runs for the deployment's whole
 * lifetime on the grants pushed by `onRunStart` at each run's dispatch
 * barrier; this forces a clean respawn -- which re-reads every step's
 * grants from the repo store during `recycle`'s respawn step -- rather
 * than let a long-lived agent run indefinitely on hours-old material
 * between runs. 24h mirrors
 * `DEFAULT_CONSUMED_RETENTION_MS`'s order of magnitude.
 */
export const DEFAULT_MAX_GRANTS_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The vendor's recycle policy also supports a `maxRssBytes` bound
 * (`RecyclePolicyBounds.maxRssBytes`, consulted via a `readRssBytes`
 * reader the host supplies -- see `types.ts:473-499`). This wiring
 * deliberately does NOT arm it: the reader's contract is "the workflow-
 * process child's current resident-set size", but the only pid this
 * wiring ever observes is the one returned by the FIRST `spawn()`
 * (`SpawnResult.pid`) -- `recycle()`'s own return value (`RecycleAttempt`)
 * never surfaces the respawned child's pid, and recycle can be triggered
 * by the operator, the policy itself, or the child's own
 * `recycle.request` control frame, any of which silently retires the pid
 * this wiring would otherwise be reading. A reader that keeps polling a
 * stale (possibly OS-recycled) pid across a respawn would make the bound
 * actively wrong rather than merely absent, so it is left unwired until
 * the vendor surfaces the live child's pid across a recycle.
 */

// `assembleRunCredentialsSnapshot` and the `onRunStart` wiring below are
// ported from upstream Interchange's sidecar (apps/sidecar/src/
// workflow-host-wiring.ts at the vendored pin 55c4431e), adapted only to
// this directory's `deploymentId` naming (upstream: `anchorRunId`) for the
// deployment-level id. Before this port, `createSidecarWorkflowSupervisor`
// never wired `onRunStart`, so the vendor supervisor's per-run grants
// barrier (`pushRunGrants`) never armed and a one-shot post-spawn
// `deliverCredentials` push stood in as an interim substitute (removed by
// this port).

export type AssembleRunCredentialsSnapshotOpts = {
  /** Substrate handle the sink reads the per-run grants file from. */
  repoStore: RepoStore;
  /** Deployment id keying the workflow-run repo the grants file lives in. */
  deploymentId: string;
  /** Run whose per-run grants file is read. */
  runId: string;
  /** Step ids in `stepOrder`; the per-run grants apply uniformly across them. */
  stepOrder: readonly string[];
  /** Per-step mail-address derivation. */
  deriveStepAddress: DeriveStepAddress;
};

/**
 * Resolve a run's credentials snapshot for the `onRunStart` grants
 * barrier from its per-run grants file.
 *
 * Every legitimate run birth path writes `runs/<runId>/grants.json` in
 * the deployment's workflow-run repo before the run dispatches -- the
 * external trigger route and the mail-triggered path both ship a
 * `run.grants` frame the sidecar writes, and a spawned child inherits its
 * parent's grants directly at spawn without reaching this barrier. The
 * per-run file IS the run's snapshot: the run's single flat grant set is
 * applied uniformly across every step, keyed on each step's address.
 *
 * A missing file is therefore not an internal run inheriting deploy-time
 * grants -- it is a run that reached its barrier with no grants written,
 * so it FAILS CLOSED here rather than running under-authorized. A file
 * that exists but is malformed also throws (via `readRunGrants`), for the
 * same reason: the file's presence implies a grants frame was delivered,
 * so a structural failure is a boundary bug, not a default.
 */
export async function assembleRunCredentialsSnapshot(
  opts: AssembleRunCredentialsSnapshotOpts,
): Promise<CredentialsSnapshot> {
  const runGrants = await readRunGrants({
    repoStore: opts.repoStore,
    deploymentId: opts.deploymentId,
    runId: opts.runId,
  });
  if (runGrants === undefined) {
    // Upstream fails closed here because its hub writes
    // `runs/<runId>/grants.json` on every run birth path. THIS hub does
    // not ship that `run.grants` frame yet (CL-6194 reopened), so an
    // absent file is the normal case for every chat-minted channel host,
    // not evidence of a failed grants write — failing closed bricked all
    // new workbenches (observed live 18/08). Start with an empty
    // snapshot; the post-spawn `deliverCredentials` push in
    // workflow-host-wiring/index.ts seeds material as before the port.
    // Restore the fail-closed branch when the hub produces the file.
    return { steps: [] };
  }
  const contentHash = await hashGrants(runGrants);
  const steps: CredentialsSnapshotStep[] = opts.stepOrder.map((stepId) => ({
    stepId,
    address: opts.deriveStepAddress({
      runId: opts.deploymentId,
      stepId,
    }),
    grants: runGrants,
    contentHash,
  }));
  return { steps };
}

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
  deploymentId: string;
  /**
   * Step count of the deployed `WorkflowDefinition` (`stepOrder.length`).
   * Threaded into the child's spawn-time env so its deploy-tree read
   * collapses onto the head for a single-step deployment.
   */
  stepCount: number;
  /**
   * Step ids in the deployed `WorkflowDefinition`'s `stepOrder`. The
   * `onRunStart` grants sink walks these to assemble the per-run
   * credentialsSnapshot from each step's per-run grants file, so the sink
   * needs the ordered ids rather than the bare count.
   */
  stepOrder: readonly string[];
  /** Deployment's mail address. */
  deploymentMailAddress: string;
  /** Per-step mail-address derivation. */
  deriveStepAddress: DeriveStepAddress;
  /**
   * Optional override of the per-step `agent-state` repo identity the
   * supervisor reads grants from while assembling the
   * credentialsSnapshot. Defaults to the `<deploymentId>-<stepId>`
   * convention; the single-step launched-agent deploy supplies a
   * derivation that returns the legacy agent-state repo so the spawned
   * child reads grants from the same repo the legacy agent identity
   * keys.
   */
  deriveStepRepoId?: DeriveStepRepoId;
  /** Substrate-config keys propagated to the child via spawn-time env. */
  substrateEnv: Record<string, string>;
  /**
   * Dynamic spawn-env fragment the supervisor recomputes on every spawn and
   * recycle respawn (e.g. a live-rotated inference-source list). Its keys
   * layer over `substrateEnv`. See the `dynamicSpawnEnv` supervisor binding.
   */
  dynamicSpawnEnv: () => Record<string, string>;
  /**
   * Override the subprocess spawner. Tests inject a deterministic
   * mock; production defaults to the `Bun.spawn`-backed
   * `defaultSubprocessSpawner`.
   */
  subprocessSpawner?: SubprocessSpawner;
  /** Override the `bin/workflow-child` path. */
  binaryPath?: string;
  /**
   * Optional per-message dispatch-timing observer, forwarded verbatim to
   * the supervisor's `onDispatchTiming` binding. Absent in production;
   * the deploy router wires it (off a benchmark env gate) only when
   * measuring dispatch latency, which needs the supervisor to emit the
   * per-message infra round-trip from inside the sidecar subprocess.
   */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /**
   * forced-repack A/B toggle, forwarded verbatim to the
   * supervisor's `repackEveryMessages` binding. Absent in production;
   * the deploy router wires it (off the same benchmark env gate) only
   * when measuring how repack frequency contributes to latency.
   */
  repackEveryMessages?: { everyMessages: number };
  /**
   * Consumed-dedup retention horizon (ms), forwarded to the
   * supervisor's `consumedRetentionMs` binding. The boot edge resolves
   * the operator's `CONSUMED_RETENTION_MS` config; absent, the
   * supervisor applies `DEFAULT_CONSUMED_RETENTION_MS` (24h).
   */
  consumedRetentionMs?: number;
  /**
   * Spawn ready-handshake timeout (ms), forwarded to the supervisor's
   * `readyTimeoutMs` binding. The boot edge resolves the operator's
   * `CHILD_READY_TIMEOUT_MS` config; absent, the supervisor applies
   * `DEFAULT_READY_TIMEOUT_MS` (30s).
   */
  readyTimeoutMs?: number;
  /**
   * Whether this deployment's child warm-keeps its agent across messages
   * (the single-step launched-agent deploy; see `SpawnOpts.warmKeep`).
   * Gates the recycle policy this wiring arms: a warm-keep child is the
   * only shape whose grants can go stale over a long-lived process, so
   * `true` arms `recyclePolicy.maxGrantsAgeMs` (`DEFAULT_MAX_GRANTS_AGE_MS`)
   * and its `readGrantsAgeMs` reader. A per-message multi-step child tears
   * down and respawns fresh every message and has no long-running grants
   * to police, so `false` (the default) leaves the recycle policy unarmed.
   */
  warmKeep?: boolean;
  /**
   * Control-plane suspension sink, forwarded verbatim to the supervisor's
   * `onSuspensionRegister` binding. Production wires this to the sidecar's
   * hub link (`HubLink.sendSignalCorrelationRegister`) so an ask-rail
   * suspension's approval snapshot reaches the hub as a
   * `signal.correlation.register` frame; the hub co-writes the run's
   * routing + approval rows from it. Omitted, a workflow-child suspend
   * never registers an approval and the run parks invisibly forever.
   */
  onSuspensionRegister?: (registration: SuspensionRegistration) => void;
  /**
   * Decrypted credential material from the deploy frame's
   * `workflow.credentials`, forwarded verbatim to the supervisor's
   * `credentialDelivery` binding so the child's materialRef is seeded on
   * the pre-trigger barrier. Omitted, every tool-package
   * `credentials.resolve(handle)` fails "no credential is bound" even
   * though the hub resolved and delivered the material on the frame.
   * Absent on the boot-restore path by construction: secrets are never
   * persisted sidecar-side, so a restored deployment waits for the hub's
   * `credentials.update` push.
   */
  credentialDelivery?: import("@intx/types/sidecar").CredentialDelivery;
};

export type SidecarWorkflowSupervisor = {
  supervisor: WorkflowSupervisor;
  /**
   * Hand a delivered inbound message off to the supervisor's mail
   * subscription. The returned promise resolves once the message is durably
   * accepted and rejects when it was not, so the hub-link can send a
   * `mail.inbound.ack` only on resolution (resolve = ack, reject = withhold).
   */
  routeInbound(message: Uint8Array): Promise<void>;
  /** Snapshot accessor that proxies the supervisor's credentials view. */
  getCredentialsSnapshot(): CredentialsSnapshot | null;
  /**
   * Direct SIGKILL of the most recently spawned child, bypassing the
   * supervisor's own graceful `shutdown()` sequencing entirely. The CL-5477
   * idle-reap park path's shutdown escalation (`shutdownSupervisorWithEscalation`)
   * calls this from a bare `setTimeout` when `shutdown()` has not settled
   * within the escalation window, so a wedged child cannot block a park or
   * a process-exit drain forever. Safe to call at any point, including
   * mid-await inside `shutdown()`'s own teardown: `Bun.spawn`'s `kill()` is
   * idempotent against an already-exited or already-killed process.
   */
  hardKillChild(): void;
};

/**
 * Logical mail-audit reference the supervisor stamps onto every
 * inbox/processing/consumed envelope for sidecar-hosted deployments.
 * The substrate does not dereference the value; it is a host-side
 * pointer the audit consumer joins on. The mail audit is keyed by the
 * deployment id plus the parsed messageId, which is unique per inbound
 * message and stable across the FIFO pipeline's
 * enqueue/dequeue/markConsumed transitions.
 */
export function deriveSidecarMailAuditRef(deploymentId: string): (
  messageId: string,
  rawMessage: Uint8Array,
) => {
  store: string;
  path: string;
} {
  return (messageId, _rawMessage) => ({
    store: "sidecar-mail-audit",
    path: `${deploymentId}/${messageId}`,
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
  const mailBus: HubTransportMailBusAdapter = wrapHubTransportAsMailBus(
    opts.transport,
  );
  // Tracks the most recently spawned child's handle so `hardKillChild` can
  // reach it directly. The `WorkflowSupervisor` interface exposes no raw
  // handle access, so wrapping the spawner -- the same injection point
  // tests already use -- is the only seam that sees it. Re-assigned on
  // every spawn call, including a recycle's respawn, so it always points
  // at the live child.
  let currentHandle: SubprocessHandle | undefined;
  const baseSpawner = opts.subprocessSpawner ?? defaultSubprocessSpawner;
  const trackingSpawner: SubprocessSpawner = (spawnArgs) => {
    const handle = baseSpawner(spawnArgs);
    currentHandle = handle;
    return handle;
  };
  // Wall-clock of the most recent credentials push -- either an `onRunStart`
  // grants-barrier snapshot or a `deliverCredentials` rotation -- read by
  // `readGrantsAgeMs` below. `undefined` until the first delivery, which
  // matches the vendor reader's contract: "or `undefined` if no refresh
  // has been observed yet" (`types.ts:483-488`).
  let lastGrantsRefreshAt: number | undefined;
  const supervisorPrincipal: WorkflowRunSupervisorPrincipal = {
    kind: "supervisor",
    anchorRunId: opts.deploymentId,
  };
  // Per-run grants sink. The supervisor awaits this and pushes the
  // resulting snapshot to the child before the run's `trigger.fire`; a
  // throw propagates and the dispatch barrier fails the run rather than
  // firing the trigger against absent grants. The snapshot is the run's
  // own per-run grants file, which every legitimate birth path writes
  // before dispatch (see `assembleRunCredentialsSnapshot`). Once wired,
  // this is the SOLE grants push for the deployment's lifetime (the
  // vendor supervisor suppresses its own spawn-time push), so it is also
  // the observation point `readGrantsAgeMs` below keys off for a
  // warm-keep deployment's staleness bound.
  const onRunStart = async (args: {
    runId: string;
    anchorRunId: string;
  }): Promise<CredentialsSnapshot> => {
    const snapshot = await assembleRunCredentialsSnapshot({
      repoStore: opts.repoStore,
      deploymentId: args.anchorRunId,
      runId: args.runId,
      stepOrder: opts.stepOrder,
      deriveStepAddress: opts.deriveStepAddress,
    });
    lastGrantsRefreshAt = Date.now();
    return snapshot;
  };
  const supervisorBaseConfig = {
    repoStore: opts.repoStore,
    signAsPrincipal: (async (kind, payload) => {
      const sig = await signEd25519(opts.signingKeySeed, payload);
      return { sig, principalKind: kind };
    }) satisfies PrincipalSigner,
    mailBus,
    subprocessSpawner: trackingSpawner,
    binaryPath: opts.binaryPath ?? SIDECAR_WORKFLOW_CHILD_BINARY,
    substrateEnv: opts.substrateEnv,
    dynamicSpawnEnv: opts.dynamicSpawnEnv,
    onRunStart,
    workflowRunRepoId: opts.workflowRunRepoId,
    workflowRunRef: opts.workflowRunRef,
    anchorRunId: opts.deploymentId,
    stepCount: opts.stepCount,
    deploymentMailAddress: opts.deploymentMailAddress,
    readPrincipal: supervisorPrincipal,
    deriveStepAddress: opts.deriveStepAddress,
    deriveMailAuditRef: deriveSidecarMailAuditRef(opts.deploymentId),
  };
  const supervisorConfigWithOnSuspensionRegister =
    opts.onSuspensionRegister !== undefined
      ? {
          ...supervisorBaseConfig,
          onSuspensionRegister: opts.onSuspensionRegister,
        }
      : supervisorBaseConfig;
  const supervisorConfigWithCredentialDelivery =
    opts.credentialDelivery !== undefined
      ? {
          ...supervisorConfigWithOnSuspensionRegister,
          credentialDelivery: opts.credentialDelivery,
        }
      : supervisorConfigWithOnSuspensionRegister;
  const supervisorConfigWithDeriveStepRepoId =
    opts.deriveStepRepoId !== undefined
      ? {
          ...supervisorConfigWithCredentialDelivery,
          deriveStepRepoId: opts.deriveStepRepoId,
        }
      : supervisorConfigWithCredentialDelivery;
  const supervisorConfigWithOnDispatchTiming =
    opts.onDispatchTiming !== undefined
      ? {
          ...supervisorConfigWithDeriveStepRepoId,
          onDispatchTiming: opts.onDispatchTiming,
        }
      : supervisorConfigWithDeriveStepRepoId;
  const supervisorConfigWithRepackEveryMessages =
    opts.repackEveryMessages !== undefined
      ? {
          ...supervisorConfigWithOnDispatchTiming,
          repackEveryMessages: opts.repackEveryMessages,
        }
      : supervisorConfigWithOnDispatchTiming;
  const supervisorConfigWithConsumedRetentionMs =
    opts.consumedRetentionMs !== undefined
      ? {
          ...supervisorConfigWithRepackEveryMessages,
          consumedRetentionMs: opts.consumedRetentionMs,
        }
      : supervisorConfigWithRepackEveryMessages;
  const supervisorConfigWithReadyTimeoutMs =
    opts.readyTimeoutMs !== undefined
      ? {
          ...supervisorConfigWithConsumedRetentionMs,
          readyTimeoutMs: opts.readyTimeoutMs,
        }
      : supervisorConfigWithConsumedRetentionMs;
  // Recycle policy is armed only for a warm-keep child (see `warmKeep`'s
  // doc comment); a per-message multi-step child has nothing for it to
  // police. `maxRssBytes`/`readRssBytes` are intentionally absent -- see
  // the module-level comment above `DEFAULT_MAX_GRANTS_AGE_MS`.
  const recyclePolicy: RecyclePolicyBounds | undefined = opts.warmKeep
    ? { maxGrantsAgeMs: DEFAULT_MAX_GRANTS_AGE_MS }
    : undefined;
  const supervisorConfig =
    recyclePolicy !== undefined
      ? {
          ...supervisorConfigWithReadyTimeoutMs,
          recyclePolicy,
          readGrantsAgeMs: () =>
            lastGrantsRefreshAt === undefined
              ? undefined
              : Date.now() - lastGrantsRefreshAt,
        }
      : supervisorConfigWithReadyTimeoutMs;
  const supervisor = createWorkflowSupervisor(supervisorConfig);
  return {
    supervisor: {
      ...supervisor,
      async deliverCredentials(
        args: Parameters<WorkflowSupervisor["deliverCredentials"]>[0],
      ): Promise<void> {
        await supervisor.deliverCredentials(args);
        lastGrantsRefreshAt = Date.now();
      },
    },
    routeInbound(message) {
      return mailBus.routeInbound(opts.deploymentMailAddress, message);
    },
    getCredentialsSnapshot: () => supervisor.getCredentialsSnapshot(),
    hardKillChild() {
      // This runs from a bare `setTimeout` callback on the shutdown-escalation
      // path: an uncaught throw here becomes an unhandled rejection that
      // skips a clean park/exit, which is exactly the failure mode this
      // exists to eliminate.
      try {
        currentHandle?.kill("SIGKILL");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn`hardKillChild: kill("SIGKILL") threw: ${message}`;
      }
    },
  };
}
