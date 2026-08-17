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
  wrapHubTransportAsMailBus,
  type CredentialsSnapshot,
  type DeriveStepAddress,
  type DeriveStepRepoId,
  type DispatchTimingMark,
  type HubTransportMailBusAdapter,
  type PrincipalSigner,
  type SubprocessSpawner,
  type SuspensionRegistration,
  type WorkflowSupervisor,
} from "@intx/workflow-host";

import {
  defaultSubprocessSpawner,
  SIDECAR_WORKFLOW_CHILD_BINARY,
} from "./transport";

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
   * Control-plane suspension sink, forwarded verbatim to the supervisor's
   * `onSuspensionRegister` binding. Production wires this to the sidecar's
   * hub link (`HubLink.sendSignalCorrelationRegister`) so an ask-rail
   * suspension's approval snapshot reaches the hub as a
   * `signal.correlation.register` frame; the hub co-writes the run's
   * routing + approval rows from it. Omitted, a workflow-child suspend
   * never registers an approval and the run parks invisibly forever.
   */
  onSuspensionRegister?: (registration: SuspensionRegistration) => void;
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
  const supervisorPrincipal: WorkflowRunSupervisorPrincipal = {
    kind: "supervisor",
    anchorRunId: opts.deploymentId,
  };
  const supervisorBaseConfig = {
    repoStore: opts.repoStore,
    signAsPrincipal: (async (kind, payload) => {
      const sig = await signEd25519(opts.signingKeySeed, payload);
      return { sig, principalKind: kind };
    }) satisfies PrincipalSigner,
    mailBus,
    subprocessSpawner: opts.subprocessSpawner ?? defaultSubprocessSpawner,
    binaryPath: opts.binaryPath ?? SIDECAR_WORKFLOW_CHILD_BINARY,
    substrateEnv: opts.substrateEnv,
    dynamicSpawnEnv: opts.dynamicSpawnEnv,
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
  const supervisorConfigWithDeriveStepRepoId =
    opts.deriveStepRepoId !== undefined
      ? {
          ...supervisorConfigWithOnSuspensionRegister,
          deriveStepRepoId: opts.deriveStepRepoId,
        }
      : supervisorConfigWithOnSuspensionRegister;
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
  const supervisorConfig =
    opts.readyTimeoutMs !== undefined
      ? {
          ...supervisorConfigWithConsumedRetentionMs,
          readyTimeoutMs: opts.readyTimeoutMs,
        }
      : supervisorConfigWithConsumedRetentionMs;
  const supervisor = createWorkflowSupervisor(supervisorConfig);
  return {
    supervisor,
    routeInbound(message) {
      return mailBus.routeInbound(opts.deploymentMailAddress, message);
    },
    getCredentialsSnapshot: () => supervisor.getCredentialsSnapshot(),
  };
}
