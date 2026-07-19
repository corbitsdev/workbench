// Thin wiring module that constructs `createWorkflowSupervisor` with
// this sidecar's host-specific bindings: the existing mail-bus
// instance, the sidecar's Ed25519 signing keypair, the substrate
// RepoStore handle, and `Bun.spawn` as the subprocess spawner. Any
// logic that would benefit a future alternative-sidecar
// implementation lives inside `@workbench/workflow-host`, not here.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

import { type } from "arktype";

import { derivePublicKeyBytes, signEd25519 } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type { HubTransport } from "@intx/mail-memory";
import {
  parseAgentId,
  type Principal,
  type RepoId,
  type RepoStore,
  type WorkflowRunSupervisorPrincipal,
} from "@intx/hub-sessions";
import type {
  AgentKeyStore,
  AssistantLoopGuard,
  DeployRouter,
  DeployRouterResult,
  SessionManager,
} from "@workbench/hub-agent";
// WORKBENCH-LOCAL (CL-2231): the on-disk step-agent dir layout for the
// undeploy reclaim sweep (T1 seam — must match what the substrate writes).
// createAssistantLoopGuard: re-homed loop-guard consumer default (see
// assistant-loop-guard-wiring.ts) — the guard's own logic is untouched.
import {
  createAssistantLoopGuard,
  sanitizeAddress,
} from "@workbench/hub-agent";
import {
  createWorkflowSupervisor,
  STEP_GRANTS_PATH,
  STEP_GRANTS_REF,
  wrapHubTransportAsMailBus,
  type CredentialsSnapshot,
  type DeriveStepAddress,
  type DeriveStepRepoId,
  type DispatchTimingMark,
  type FrameReader,
  type HubTransportMailBusAdapter,
  type NdjsonReader,
  type NdjsonWriter,
  type SpawnOpts,
  type SubprocessHandle,
  type SubprocessSpawner,
  type WorkflowSupervisor,
} from "@workbench/workflow-host";
import { hexEncode } from "@intx/types";
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
import { STEP_ID_PATTERN } from "@intx/workflow";
import { deriveWorkflowRunRepoId } from "@intx/workflow-deploy";

import { observeInferenceEventForAssistantLoopGuard } from "./assistant-loop-guard-wiring";
import type {
  MultistepDrainRouter,
  MultistepMailRouter,
  MultistepSignalRouter,
  MultistepSourcesRouter,
} from "./workflow-run-pack-client";
import {
  reclaimWorkflowDeploymentDir,
  workflowDeploymentDir,
} from "./workflow-deployment-dirs";
import { readChildRssBytes } from "./workflow-child-rss";
import { SIDECAR_SUBSTRATE_CONFIG_KEYS } from "./workflow-substrate-factory";

const logger = getLogger(["interchange", "sidecar", "workflow-host-wiring"]);

// WORKBENCH-LOCAL (CL-2199): the raw hub deploymentId (`ses_<id>`) env key.
// The step tool-context resolver derives the step agent row id
// (`ins_<raw>-<step>`) and agent-state repo id (`<raw>-<step>`) from this, NOT
// from the slugified workflow-run repo id. `SubstrateConfig` in
// workflow-substrate-factory.ts REQUIRES this key and the workflow-child's
// `filterSubstrateConfig` throws without it, so an upstream re-sync that drops
// it breaks every workflow-child spawn at runtime with a green build.
export const RAW_DEPLOYMENT_ID_ENV_KEY = "WORKFLOW_RAW_DEPLOYMENT_ID";

// WORKBENCH-LOCAL (CL-2199): recover the raw deploymentId by stripping the
// `ins_` instance prefix off the deployment's INSTANCE ID
// (`parseAgentId(frame.agentAddress)`), which is shape-agnostic across both
// deploy families:
//   - multi-step: the deployment address is `ins_<deploymentId>@<domain>`, so
//     its instance id is `ins_<deploymentId>` — identical to the frame's
//     `agentId` (`deriveDeploymentAgentId`), yielding `<deploymentId>` exactly
//     as before.
//   - single-agent: the frame's `agentId` is the REAL agent def id
//     (`agt_<defId>`, which the child resolves skills/tools/pins by), so it
//     cannot be stripped; the instance id `ins_<hex>` off the address yields
//     `<hex>`.
// Recovering off the address (not the agentId) is what lets a single-agent
// deploy pass this point instead of throwing. Fails loudly on an instance id
// that does not carry the `ins_` prefix.
export function deriveRawDeploymentId(instanceId: string): string {
  const prefix = "ins_";
  if (!instanceId.startsWith(prefix) || instanceId.length === prefix.length) {
    throw new Error(
      `sidecar deploy router: cannot recover raw deploymentId from instance id ${JSON.stringify(instanceId)}; expected an "ins_<id>" instance id (from parseAgentId(agentAddress))`,
    );
  }
  return instanceId.slice(prefix.length);
}

/**
 * WORKBENCH-LOCAL (CL-2363): not in upstream interchange — preserve on pin-bump
 * re-sync of this vendored file.
 *
 * Deploy-time completeness assertion for the multi-step workflow-child's
 * substrate-config env. The hand-off between this wiring and the workflow-child
 * is duck-typed (no compile-time contract), so a dropped substrate-config key
 * does NOT fail the build — it surfaces only when the child boots and its
 * `filterSubstrateConfig` validator throws, i.e. a runtime child-spawn crash in
 * production. Asserting presence + non-emptiness of every
 * `SIDECAR_SUBSTRATE_CONFIG_KEYS` member here converts that silent runtime
 * crash into a loud deploy-time failure naming the missing key. The env passed
 * in must be the UNION of the static `substrateEnv` and the dynamic spawn-env
 * fragment (`STEP_INFERENCE_SOURCES`), since the child receives both merged.
 */
function assertSubstrateEnvComplete(env: Record<string, string>): void {
  for (const key of SIDECAR_SUBSTRATE_CONFIG_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `sidecar deploy router: assembled workflow-child substrate env is missing required key ${JSON.stringify(key)} (present in SIDECAR_SUBSTRATE_CONFIG_KEYS but absent or empty in the spawn-time env); a dropped substrate-config key would crash the workflow-child at boot`,
      );
    }
  }
}

/**
 * Project an agent address into the substrate-safe id of its
 * workflow-run repo. Both deploy branches key `{ kind: "workflow-run",
 * id }` by this slug, and the supervisor principal's `deploymentId`
 * must equal that id for the workflow-run kind handler's authz check to
 * pass. The derivation is owned by `@intx/workflow-deploy` so the hub's
 * read routes reconstruct the identical id; this thin delegator keeps
 * the sidecar's call sites readable while the rationale and the
 * substrate `SAFE_REPO_ID` contract live with the shared function.
 */
export function deriveDeploymentId(agentAddress: string): string {
  return deriveWorkflowRunRepoId(agentAddress);
}

/**
 * Hub principal the deploy router presents when it writes a step's
 * grants into the agent-state repo on the sidecar's substrate. The
 * agent-state kind handler gates `writeTree` as hub-only; the deploy
 * router is the local stand-in for the hub on the sidecar's disk, so it
 * claims the hub principal for this single bookkeeping write. The child
 * reads the same repo via the working-tree path (`getRepoDir`), which is
 * not authorize-gated.
 */
const GRANTS_WRITE_PRINCIPAL: Principal = { kind: "hub" };

/**
 * Per-deploy address/repo strategy. The single-step launched-agent
 * deploy and the derived multi-step deploy disagree on how the per-step
 * mail address and agent-state repo id are computed; both
 * `deriveStepAddress` (consumed by the supervisor's credentialsSnapshot
 * assembly for the step's mail address) and `deriveStepRepoId` (consumed
 * by the same assembly to locate each step's grants) must agree on the
 * choice, so they are minted together.
 */
type StepStrategy = {
  deriveStepAddress: DeriveStepAddress;
  deriveStepRepoId: DeriveStepRepoId;
};

/**
 * Decide the per-step address/repo strategy from the projection's step
 * count.
 *
 * `stepOrder.length === 1` is the agent-launch identity deploy: the sole
 * step IS the legacy launched agent, so its grants live in the legacy
 * agent-state repo keyed by `parseAgentId(legacyAddress)`. This is
 * exactly the repo the legacy agent identity keys, so the spawned child
 * reads the agent's grants from where the agent's identity already
 * lives, and the deployment frame's `ins_<hex>` address is preserved
 * (the deploy-ack listener finds the `agent_instance` row, the
 * workflow-run repo stays keyed by `deriveWorkflowRunRepoId(legacy)`).
 *
 * Any other step count is a derived multi-step deploy: each step gets a
 * derived `<deploymentId>-<stepId>` mail address (via the router's
 * `multistepDeriveStepAddress`) and a derived agent-state repo under the
 * default `<deploymentId>-<stepId>` convention.
 *
 * NOTE: the supervisor's `deriveStepAddress` feeds the credentials
 * snapshot's per-step mail `address` and the grants-repo derivation. It
 * does NOT feed the child's on-disk tool read (`stepDeployTreeDir` in
 * `step-agent-tools.ts`), which re-derives the step address from the
 * deployment mailbox address independently. The deploy tree must
 * therefore be staged at the address `stepDeployTreeDir` computes,
 * regardless of this strategy's address choice.
 */
function createStepStrategy(args: {
  legacyAddress: string;
  stepOrder: readonly string[];
  multistepDeriveStepAddress: DeriveStepAddress;
}): StepStrategy {
  if (args.stepOrder.length === 1) {
    return {
      deriveStepAddress: () => args.legacyAddress,
      // `parseAgentId` is deferred into the closure rather than computed
      // eagerly: the supervisor only invokes `deriveStepRepoId` while
      // assembling the credentialsSnapshot inside `spawn()`, so a
      // malformed address surfaces at the same point the rest of the
      // spawn path would fault rather than ahead of the deploy router's
      // other boundary checks.
      deriveStepRepoId: () => ({
        kind: "agent-state",
        id: parseAgentId(args.legacyAddress),
      }),
    };
  }
  return {
    deriveStepAddress: args.multistepDeriveStepAddress,
    deriveStepRepoId: ({ deploymentId, stepId }) => ({
      kind: "agent-state",
      id: `${deploymentId}-${stepId}`,
    }),
  };
}

/**
 * Write every step's grants into its agent-state repo so the
 * supervisor's `assembleCredentialsSnapshot` (invoked inside `spawn()`)
 * reads them off the working tree at `STEP_GRANTS_PATH`. The on-disk
 * shape is `{ grants: WireGrantRule[] }` -- the envelope
 * `assembleCredentialsSnapshot` validates (`{ grants: unknown[] }`) and
 * the child's `evaluateGrants` adapter narrows to `GrantRule[]`.
 *
 * The same `deriveStepRepoId` the supervisor reads with keys the write,
 * so read and write address the same repo. The write is on the spawn
 * critical path: a failure rejects the deploy (the caller's `finally`
 * unwinds the partial state) rather than spawning a child that would
 * fail every authorize closed against an empty grant set.
 */
export const STEP_GRANTS_PATH_FOR_TEST = STEP_GRANTS_PATH;

export async function writeStepGrants(args: {
  repoStore: RepoStore;
  deploymentId: string;
  stepOrder: readonly string[];
  deriveStepRepoId: DeriveStepRepoId;
  grants: readonly unknown[] | undefined;
}): Promise<void> {
  // The deploy frame's validated HarnessConfig always carries a `grants`
  // array (possibly empty); an absent array means "no grants", which
  // serializes to the same fail-closed empty file the snapshot expects.
  // Coerce here so the on-disk envelope is always a valid `{ grants: [] }`
  // rather than `{}` (which the snapshot's validator rejects).
  const grants = args.grants ?? [];
  const serialized = JSON.stringify({ grants }, null, 2);

  async function writeOne(stepId: string): Promise<void> {
    const repoId = args.deriveStepRepoId({
      deploymentId: args.deploymentId,
      stepId,
    });
    await args.repoStore.writeTree(
      GRANTS_WRITE_PRINCIPAL,
      repoId,
      STEP_GRANTS_REF,
      {
        files: { [STEP_GRANTS_PATH]: serialized },
        message: `Write step grants for ${stepId}`,
      },
    );
  }

  // WORKBENCH-LOCAL (CL-2783): the per-step grant writes were a serial
  // `for ... await` loop. Each write is an isogit commit + fsync into a
  // DISTINCT repo (`<deploymentId>-<stepId>`). `repoStore.writeTree`
  // serializes on a per-`repoId` lock (the RepoStore substrate's
  // `withRepoLock`, mirrored by `@workbench/storage-isogit`'s per-directory
  // `withRepoDirLock` one layer down), NOT a global one, and every substrate
  // cache is keyed by `repoId` -- so concurrent writes to different step
  // repos never share a lock or torn state. Running them serially stacks
  // each step's commit+fsync wait
  // end-to-end (~254ms/step measured), which dominates cold workflow-spawn
  // latency. Parallelize with a bounded worker pool: enough concurrency to
  // overlap the fsync waits, but capped so a large workflow does not open
  // hundreds of file descriptors / commit workers at once.
  //
  // Fail-at-deploy AND straggler drain: the FIRST write failure fails the
  // deploy (this function rejects, the caller's `finally` unwinds the partial
  // deploy) -- do not swallow per-step rejections. But a bare `Promise.all`
  // rejects the instant one worker throws while sibling workers are still
  // mid-commit into their step repos; the caller's teardown (releaseSlug ->
  // a retried deploy at the same address) could then race a straggler's commit
  // into the same `<deploymentId>-<stepId>` repo. So each worker records the
  // first error and stops taking NEW work, but any in-flight `writeOne` is
  // awaited to completion; we then await EVERY worker (drain) before
  // re-throwing the first error. No writer is still mid-commit when the
  // rejection reaches teardown.
  const stepOrder = args.stepOrder;
  const poolSize = Math.min(STEP_GRANTS_WRITE_CONCURRENCY, stepOrder.length);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  async function worker(): Promise<void> {
    for (;;) {
      // Stop claiming new steps once any worker has failed: the deploy is
      // already doomed, so draining fast lets teardown proceed. An in-flight
      // write below still runs to completion, so this early-return never
      // leaves a writer mid-commit.
      if (failed) return;
      const index = cursor;
      cursor += 1;
      const stepId = stepOrder[index];
      if (stepId === undefined) return;
      try {
        await writeOne(stepId);
      } catch (cause) {
        if (!failed) {
          failed = true;
          firstError = cause;
        }
        return;
      }
    }
  }
  // Workers never reject (they capture into `firstError`), so this resolves
  // only once every worker -- including any that was mid-commit when the
  // failure was recorded -- has finished. That is the drain barrier.
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  if (failed) throw firstError;
  // WORKBENCH-LOCAL (CL-2783) end.
}

// WORKBENCH-LOCAL (CL-2783): bound on concurrent per-step grant writes.
// Chosen to overlap the isogit commit+fsync waits without opening an
// unbounded number of fds / commit workers on a large workflow.
const STEP_GRANTS_WRITE_CONCURRENCY = 12;

// The supervisor's `binaryPath` binding resolves to the sidecar's
// own `bin/workflow-child` script via `import.meta.resolve` against
// the `@intx/sidecar-app` package. The script lives next to this
// wiring module (`../bin/workflow-child`); resolving it statically
// at wiring-module load time keeps the production spawn surface
// independent of any runtime env override. Tests inject a sentinel
// path via the `binaryPath` opts override; production wiring
// closes over this constant.
const SIDECAR_WORKFLOW_CHILD_BINARY: string = (() => {
  const url = import.meta.resolve("../bin/workflow-child");
  return fileURLToPath(url);
})();

/**
 * Child fd the supervisor inherits the event-channel pipe on. The
 * supervisor's spawn-time convention is:
 *
 *   fd 0 stdin  -- inherited (free for the child)
 *   fd 1 stdout -- inherited so child INFO/DEBUG logs land on the
 *                  sidecar's stdout at correct severity
 *   fd 2 stderr -- inherited so child WARN/ERROR logs land on the
 *                  sidecar's stderr
 *   fd 3        -- event-channel write side (child writes
 *                  HMAC-authenticated InferenceEvent frames here;
 *                  the supervisor reads the parent end as a
 *                  `FrameReader`)
 *   fd 4        -- downstream control channel (supervisor -> child;
 *                  the supervisor writes, the child reads)
 *   fd 5        -- upstream control channel (child -> supervisor; the
 *                  child writes, the supervisor reads)
 *
 * WORKBENCH-LOCAL (CL-2585): the control channel used to ride fd 0/1
 * (stdin/stdout). But stdout is also where `@intx/log` routes
 * INFO/DEBUG, so a log line interleaved into the NDJSON control
 * stream and crashed the supervisor's control reader (-> reason=corrupt).
 * Control now lives on its own dedicated fds (4 down, 5 up) so
 * stdin/stdout/stderr are free to inherit. The control channel is
 * bidirectional, so it needs TWO pipes (a single Bun `"pipe"` slot is
 * unidirectional). The child opens fds 3/4/5 via `EVENT_CHANNEL_FD` /
 * `CONTROL_DOWN_FD` / `CONTROL_UP_FD` in `@workbench/workflow-host`'s
 * `from-process-env`; these indices must stay in lockstep with the
 * `stdio` slots below. Each `stdio[n] = "pipe"` for n >= 3 makes Bun
 * mint a pipe pair where the child inherits one half at fd n and the
 * parent receives the other half as a numeric fd at `proc.stdio[n]`.
 */
const CHILD_EVENT_CHANNEL_FD = 3;
// WORKBENCH-LOCAL (CL-2585): dedicated control-channel fds; mirror
// `CONTROL_DOWN_FD` / `CONTROL_UP_FD` in the workflow-child's
// `from-process-env`. Must stay in lockstep with the `stdio` indices.
const CHILD_CONTROL_DOWN_FD = 4;
const CHILD_CONTROL_UP_FD = 5;

/**
 * Wrap a Bun `FileSink` as the supervisor's `NdjsonWriter`. The
 * supervisor's control-channel sender writes one JSON line per
 * frame (already including the trailing newline); the writer is
 * responsible for passing the bytes through to the child's stdin
 * without buffering across frames so each frame surfaces on the
 * far side as soon as `write()` resolves.
 */
function ndjsonWriterFromFileSink(sink: Bun.FileSink): NdjsonWriter {
  return {
    async write(line: string): Promise<void> {
      const result = sink.write(line);
      if (typeof result !== "number") await result;
      const flushed = sink.flush();
      if (typeof flushed !== "number") await flushed;
    },
  };
}

/**
 * Wrap a Bun stdout `ReadableStream` as the supervisor's
 * `NdjsonReader`. The pipe is a byte stream; this reader buffers
 * partial chunks and yields one complete line per iteration. The
 * receiver's iterator finalises only on EOF, which mirrors the
 * `defaultControlReader` shape the child wires for `process.stdin`.
 */
function ndjsonReaderFromReadableStream(
  stream: ReadableStream<Uint8Array>,
): NdjsonReader {
  return {
    read(): AsyncIterableIterator<string> {
      return (async function* () {
        const decoder = new TextDecoder("utf-8");
        let pending = "";
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value !== undefined) {
              pending += decoder.decode(value, { stream: true });
              let nl = pending.indexOf("\n");
              while (nl >= 0) {
                const line = pending.slice(0, nl).replace(/\r$/, "");
                pending = pending.slice(nl + 1);
                if (line.length > 0) yield line;
                nl = pending.indexOf("\n");
              }
            }
            if (done) break;
          }
          if (pending.length > 0) yield pending;
        } finally {
          reader.releaseLock();
        }
      })();
    },
  };
}

/**
 * Wrap the parent-side read fd of the event-channel pipe as the
 * supervisor's `FrameReader`. The child publishes one HMAC-
 * authenticated envelope per `FileSink.write()` and the supervisor's
 * `receiveEventChannel` parses each yielded `Uint8Array` as one
 * complete envelope. The pipe is a byte stream; this reader yields
 * each raw chunk the kernel delivers and trusts the sender's
 * one-write-per-envelope discipline. The buffer-overflow / framing
 * discipline lives in `receiveEventChannel`'s parser.
 */
function frameReaderFromFd(fd: number): FrameReader {
  const stream = Bun.file(fd).stream();
  return {
    read(): AsyncIterableIterator<Uint8Array> {
      return (async function* () {
        const reader = stream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value !== undefined && value.byteLength > 0) yield value;
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      })();
    },
  };
}

/**
 * Real `Bun.spawn`-backed subprocess spawner. Constructs a fresh env
 * carrying exactly the trust anchors and substrate-config keys the
 * supervisor passed in (no inheritance of the sidecar's process env);
 * inherits stdio 0/1/2 as control + stderr; pipes fd 3 for the event
 * channel and surfaces the parent-side read fd as the supervisor's
 * `FrameReader`.
 *
 * Failure modes flow through the returned handle's `exited` promise.
 * A `Bun.spawn` that fails to launch (binary missing, env malformed,
 * `EXEC` error) settles `exited` with a non-zero code; the
 * supervisor's `wireChild` races `exited` against `readyPromise`
 * inside `spawn()` so a spawn-time crash surfaces as a rejected
 * spawn rather than a wedged `starting` state.
 */
export const defaultSubprocessSpawner: SubprocessSpawner = ({
  binaryPath,
  env,
}): SubprocessHandle => {
  // WORKBENCH-LOCAL (CL-2585): inherit stdin/stdout/stderr (so child logs
  // reach container logs at correct severity) and dedicate fd 3 to the event
  // channel and fds 4/5 to the down/up control channels.
  const proc = Bun.spawn([binaryPath], {
    stdio: ["inherit", "inherit", "inherit", "pipe", "pipe", "pipe"],
    env,
  });
  const eventFd = proc.stdio[CHILD_EVENT_CHANNEL_FD];
  if (typeof eventFd !== "number") {
    throw new Error(
      `workflow-host-wiring: Bun.spawn did not return a numeric fd at stdio[${String(CHILD_EVENT_CHANNEL_FD)}] for the event channel; got ${typeof eventFd}`,
    );
  }
  const controlDownFd = proc.stdio[CHILD_CONTROL_DOWN_FD];
  if (typeof controlDownFd !== "number") {
    throw new Error(
      `workflow-host-wiring: Bun.spawn did not return a numeric fd at stdio[${String(CHILD_CONTROL_DOWN_FD)}] for the downstream control channel; got ${typeof controlDownFd}`,
    );
  }
  const controlUpFd = proc.stdio[CHILD_CONTROL_UP_FD];
  if (typeof controlUpFd !== "number") {
    throw new Error(
      `workflow-host-wiring: Bun.spawn did not return a numeric fd at stdio[${String(CHILD_CONTROL_UP_FD)}] for the upstream control channel; got ${typeof controlUpFd}`,
    );
  }
  return {
    pid: proc.pid,
    // WORKBENCH-LOCAL (CL-2585): control channel rides dedicated fds 4 (down)
    // and 5 (up) instead of the child's stdin/stdout.
    controlWriter: ndjsonWriterFromFileSink(Bun.file(controlDownFd).writer()),
    controlReader: ndjsonReaderFromReadableStream(
      Bun.file(controlUpFd).stream(),
    ),
    eventReader: frameReaderFromFd(eventFd),
    kill(signal?: number | string): void {
      // The supervisor's `SubprocessHandle.kill` widens the signal
      // to `number | string`; Bun's `Subprocess.kill` accepts
      // `number | NodeJS.Signals`. The supervisor's call sites pass
      // `"SIGTERM"` / `"SIGKILL"` (recycle path) or no argument
      // (shutdown path), which Bun handles directly. Cast at the
      // boundary so the inner call matches Bun's narrower type
      // without coercing valid input.
      if (signal === undefined) {
        proc.kill();
        return;
      }
      if (typeof signal === "number") {
        proc.kill(signal);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- supervisor's kill widens to `string`; Bun's runtime accepts the same `"SIG*"` strings, narrowed back at the boundary.
      proc.kill(signal as NodeJS.Signals);
    },
    exited: proc.exited,
  };
};

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
   * the deploy router wires it (off a benchmark env gate) only for the
   * Phase 4.7 latency gate, which needs the supervisor to emit the
   * per-message infra round-trip from inside the sidecar subprocess.
   */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /**
   * D2 §10c forced-repack A/B toggle, forwarded verbatim to the
   * supervisor's `repackEveryMessages` binding. Absent in production;
   * the deploy router wires it (off the same benchmark env gate) only
   * for the D2 attribution run.
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
   * Recycle-policy bounds forwarded to the supervisor. Production
   * defaults apply a max-RSS bound so a runaway workflow child is
   * recycled instead of growing the host to multi-GB. Tests may
   * override or clear via `recyclePolicy: {}`.
   */
  recyclePolicy?: {
    maxUptimeMs?: number;
    maxRssBytes?: number;
    maxGrantsAgeMs?: number;
  };
};

export type SidecarWorkflowSupervisor = {
  supervisor: WorkflowSupervisor;
  /** Hand a delivered inbound message off to the supervisor's mail subscription. */
  routeInbound(message: Uint8Array): void;
  /** Snapshot accessor that proxies the supervisor's credentials view. */
  getCredentialsSnapshot(): CredentialsSnapshot | null;
};

// An entry in the deploy router's `activeSupervisors` map: the live supervisor
// plus the on-disk footprint the deployment owns.
type ActiveMultiStepSupervisor = {
  wired: SidecarWorkflowSupervisor;
  /**
   * WORKBENCH-LOCAL (CL-2231): not in upstream interchange — preserve across
   * the pin-bump re-sync of this vendored file (see AGENTS.md § Dockerfile
   * Maintenance → vendored workflow-host wiring).
   *
   * Absolute on-disk dirs this deployment owns, captured at deploy time so
   * the undeploy hook can reclaim the deployment's footprint regardless of
   * whether the step agents are still connected. Holds the per-deployment
   * workflow-run repo dir plus every per-step on-disk dir (each step's
   * agent-state repo dir and its agent dir). Nothing else deletes these:
   * the workflow-run repo is not an agent dir, so no undeploy path touches
   * it, and interchange's undeploy only deletes a step agent's dir while it
   * is still connected, orphaning idle-evicted steps.
   */
  ownedDirs: readonly string[];
};

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
 * Validate the wire-projected workflow definition at the deploy-router
 * boundary. The arktype `AgentDeployFrame` validator enforces the
 * wire shape (`id` is non-empty, `stepOrder` is `string[]`, `steps`
 * is an object, `sources` covers every `stepOrder` entry); this
 * function takes `unknown`-typed inputs so it can also gate callers
 * that bypass the wire boundary, and it enforces the invariants the
 * router and the downstream supervisor rely on:
 *
 *   - `definition.id` is a non-empty string. The arktype shape
 *     already enforces this on the wire; the re-check here protects
 *     bypass callers and keeps the failure shape consistent with the
 *     other invariants this function owns.
 *   - `definition.stepOrder` is non-empty. The wire shape admits
 *     `[]`; a zero-step workflow has no semantics here.
 *   - Every `stepOrder` entry matches `STEP_ID_PATTERN` so per-step
 *     mail-address derivation never needs escaping at the substrate
 *     boundary.
 *   - Every `stepOrder` entry has a corresponding `steps[id]` entry.
 *     The wire shape lets `steps[id]` be `unknown` and lets the
 *     entry be absent; presence is required so the workflow-process
 *     child can resolve each step's primitive at run time.
 *   - Every `stepOrder` entry has a corresponding `sources[id]`
 *     entry, and that entry is a non-empty array (the step's ordered
 *     failover chain). The arktype narrow already enforces both; the
 *     re-check here surfaces a structured router-side error instead of
 *     an arktype validation failure at the wire boundary, which keeps
 *     the failure shape consistent with the rest of the validations
 *     this function owns. An empty chain would leave the reactor with
 *     no initial source, so it is rejected here rather than deferred to
 *     a deep-stack child failure.
 *
 * A rejection here surfaces as a thrown `Error` the link's deploy
 * frame caller converts into a structured failure reply.
 */
export function validateWorkflowProjection(projection: {
  definition: { id: unknown; stepOrder: unknown; steps: unknown };
  sources: unknown;
}): void {
  const def = projection.definition;
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(
      "sidecar deploy router: workflow.definition.id must be a non-empty string",
    );
  }
  if (!Array.isArray(def.stepOrder) || def.stepOrder.length === 0) {
    throw new Error(
      "sidecar deploy router: workflow.definition.stepOrder must be a non-empty array",
    );
  }
  if (typeof def.steps !== "object" || def.steps === null) {
    throw new Error(
      "sidecar deploy router: workflow.definition.steps must be an object",
    );
  }
  if (typeof projection.sources !== "object" || projection.sources === null) {
    throw new Error(
      "sidecar deploy router: workflow.sources must be an object",
    );
  }
  const steps = def.steps;
  const sources = projection.sources;
  for (const stepId of def.stepOrder) {
    if (typeof stepId !== "string" || stepId.length === 0) {
      throw new Error(
        "sidecar deploy router: workflow.definition.stepOrder entries must be non-empty strings",
      );
    }
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new Error(
        `sidecar deploy router: stepId ${JSON.stringify(stepId)} must match ${STEP_ID_PATTERN.source}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(steps, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.definition.steps is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(sources, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.sources is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sources is checked to be a non-null object above; this reads a value to re-check its array shape
    const stepSources = (sources as Record<string, unknown>)[stepId];
    if (!Array.isArray(stepSources) || stepSources.length === 0) {
      throw new Error(
        `sidecar deploy router: workflow.sources[${JSON.stringify(stepId)}] must be a non-empty array (the step's ordered inference-source failover chain)`,
      );
    }
  }
}

/**
 * Project a value into a canonical JSON string with deterministically
 * sorted object keys. Used at the router boundary to mint a stable
 * content hash of the wire-projected workflow definition; the
 * orchestrator's hand-off task computes the same hash from the same
 * canonical form, so a downstream verifier comparing the two values
 * sees byte equality.
 *
 * The shape mirrors the canonicalizer the runlocal repo-store uses
 * for equality checks (`packages/workflow/src/runlocal/repo-store.ts`).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
    .join(",")}}`;
}

/**
 * Compute the deploy router's content hash for the wire-projected
 * workflow definition. SHA-256 of the canonical JSON of the
 * `WorkflowDefinition` projection, hex-encoded. The supervisor and the
 * workflow-process child read the value out of the spawn-time env
 * verbatim; it is the deployment's content-addressed handle.
 *
 * The router computes this locally so the multi-step branch does not
 * round-trip the hub for a hash the orchestrator's hand-off task will
 * also derive deterministically from the same canonical form.
 */
export async function computeWireDefinitionHash(
  definition: unknown,
): Promise<string> {
  const canonical = canonicalJsonStringify(definition);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return hexEncode(new Uint8Array(digest));
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
 * The sidecar's `DeployRouter` plus the app-only address listing. The link
 * routes `agent.deploy`/`agent.undeploy` through the `DeployRouter` surface.
 * There is no boot-time restore (CL-3884): a freshly-booted sidecar hosts
 * nothing until the hub deploys to it.
 */
export interface SidecarDeployRouter extends DeployRouter {
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
   * (§3a). Without this registration the spawned agent's address has no
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
   * Optional per-message dispatch-timing observer the multi-step branch
   * forwards to each supervisor it constructs. Resolved at the sidecar
   * boot edge from the Phase 4.7 latency-gate env gate; absent in
   * ordinary production. The supervisor runs in this sidecar subprocess,
   * so the observer sees both ends of the per-message IPC round-trip in
   * one process and can emit a parseable timing line the benchmark
   * harness reads off the subprocess's output stream.
   */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /**
   * D2 §10c forced-repack A/B toggle the multi-step branch forwards to
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
   * WORKBENCH-LOCAL (CL-2340): not in upstream — preserve on pin-bump re-sync.
   * Drain the boot-edge workflow-run pack-push pipeline for a deployment to a
   * hub-acked resting state. The undeploy hook awaits this after the
   * supervisor's `shutdown()` (so the child can append no more events) and
   * BEFORE the reclaim rm + the cursor-clearing `unregisterDeployment`, so an
   * in-flight push cannot ack after teardown and resurrect a stale delta
   * cursor (dangling-delta on the next redeploy). Optional; a router wired
   * without the pack-push facade (a test) omits it.
   */
  drainWorkflowRunPushes?: (deploymentId: string) => Promise<void>;
  /**
   * Assistant output loop guard (`@workbench/hub-agent`'s WORKBENCH-LOCAL
   * CL-3340 guard), re-homed here onto this router's `onInferenceEvent`
   * seam -- its pre-bump host, the in-process SessionManager's `onEvent`
   * stream, was deleted with the retired runtime. Shared across every
   * single-step (`warmKeep`) deployment this router spawns, keyed per call
   * by the deployment's agent address so concurrent agents never share run
   * state; the guard's own `DEFAULT_MAX_SESSIONS` eviction bounds its
   * memory as deployments churn. Optional so a test can inject a
   * deterministic guard (or assert calls against a spy); defaults to a
   * fresh `createAssistantLoopGuard()` in production.
   */
  assistantLoopGuard?: AssistantLoopGuard;
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
  const multistepSpawner =
    deps.multistepSubprocessSpawner ?? defaultSubprocessSpawner;
  const multistepDeriveStepAddress: DeriveStepAddress =
    deps.multistepDeriveStepAddress ??
    (({ deploymentId, stepId }) => `${deploymentId}-${stepId}`);
  const assistantLoopGuard =
    deps.assistantLoopGuard ?? createAssistantLoopGuard();

  // Per-deployment supervisor tracking. The multi-step branch
  // constructs one `SidecarWorkflowSupervisor` per `agent.deploy`
  // frame; the supervisor owns the workflow-process child, its IPC
  // pipes, and its event-channel fd. The undeploy hook consults this
  // map to call `supervisor.shutdown()` so the child's lifetime ends
  // with the deployment.
  const activeSupervisors = new Map<string, ActiveMultiStepSupervisor>();

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
   * Materialize the workflow definition on the sidecar's local substrate so
   * the workflow-process child's `loadWorkflowDefinition` can read
   * `workflow.json` out of the workflow-asset repo's working tree. The
   * destination mirrors the bare RepoStore's `getRepoDir` for
   * `{ kind: "workflow", id }`:
   * `${SIDECAR_DATA_DIR}/assets/workflow/<id>/workflow.json`. The child reads
   * via `fs.readFile`, so writing the bytes outside git suffices. This is
   * deploy-only durable state; the restore path finds it already on disk.
   */
  async function materializeWorkflowJson(
    sidecarDataDir: string | undefined,
    definition: NonNullable<AgentDeployFrame["workflow"]>["definition"],
  ): Promise<void> {
    if (typeof sidecarDataDir !== "string" || sidecarDataDir.length === 0) {
      throw new Error(
        "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the workflow-process child resolves the workflow-asset repo dir against this data dir",
      );
    }
    const workflowAssetPath = pathJoin(
      sidecarDataDir,
      "assets",
      "workflow",
      definition.id,
      "workflow.json",
    );
    const workflowAssetBytes = JSON.stringify(definition, null, 2);
    try {
      await mkdir(dirname(workflowAssetPath), { recursive: true });
      // Idempotent: only rewrite when the on-disk content differs. Treats a
      // missing file as different.
      let existing: string | null = null;
      try {
        existing = await readFile(workflowAssetPath, "utf8");
      } catch (cause) {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            (cause as { code: unknown }).code === "ENOENT"
          )
        ) {
          throw cause;
        }
      }
      if (existing !== workflowAssetBytes) {
        await writeFile(workflowAssetPath, workflowAssetBytes, "utf8");
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `sidecar deploy router: failed to materialize workflow.json at ${workflowAssetPath}: ${reason}`,
        { cause },
      );
    }
  }

  /**
   * Read a workflow definition back off the sidecar's local substrate for a
   * boot-time restore. Mirrors `materializeWorkflowJson`'s path derivation
   * (`${dataDir}/assets/workflow/<definitionId>/workflow.json`). Returns the
   * parsed-but-unvalidated JSON: the on-disk file is untrusted at restore
   * (partial write, corruption, tamper), so the caller re-validates it through
   * the same wire + structural gates the deploy path applies. A missing file
   * or unparseable JSON throws; the restore loop's per-record catch converts
   * that into a warn-and-skip.
   */
  async function readWorkflowJson(
    sidecarDataDir: string,
    definitionId: string,
  ): Promise<unknown> {
    const workflowAssetPath = pathJoin(
      sidecarDataDir,
      "assets",
      "workflow",
      definitionId,
      "workflow.json",
    );
    const raw = await readFile(workflowAssetPath, "utf8");
    return JSON.parse(raw);
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
    /**
     * WORKBENCH-LOCAL (CL-2199): per-deploy tenant scope the step harness
     * needs to resolve tenant-owned tool credentials + tool-package tarballs
     * and to key the durable-conversation substrate. Threaded into the child's
     * substrate env; persisted in the record so the frame-less restore path
     * rebuilds a complete env.
     */
    tenantId: string;
    /**
     * WORKBENCH-LOCAL (CL-2199): raw hub deploymentId (`ses_<id>`) the step
     * tool-context resolver derives step agent/repo ids from. Persisted in the
     * record so restore rebuilds the substrate env without the deploy frame.
     */
    rawDeploymentId: string;
    /**
     * WORKBENCH-LOCAL (CL-2199): single-agent tool identity threaded to the
     * child's substrate env. `agentId` is the deploy frame's `agentId` — for a
     * single launched agent this is the REAL agent-definition id (`agt_<defId>`)
     * the credential + hub-backed rails authorize against; for a multi-step
     * deploy it is the deployment agent id (unused by the resolver's single-agent
     * branch). `instancePrincipalId` is `frame.config.principalId` — the instance
     * principal (`prn_...`) the hub-backed identity triple resolves the owning
     * instance by. Persisted in the record so the frame-less restore path
     * rebuilds the same substrate env.
     */
    agentId: string;
    instancePrincipalId: string;
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
    // same address (the B-reroute follow-up relies on it).
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
        // WORKBENCH-LOCAL (CL-2199): per-deploy tenant scope + raw hub
        // deploymentId the workflow-child's `filterSubstrateConfig` REQUIRES
        // (both are members of SIDECAR_SUBSTRATE_CONFIG_KEYS). Not present in
        // the boot-edge `multistepSubstrateEnv` (sidecar-process constants
        // only); threaded per-deploy through the spec so the live-deploy and
        // frame-less restore paths assemble the same env. Dropping either
        // breaks every workflow-child spawn at runtime with a green build.
        TENANT_ID: spec.tenantId,
        [RAW_DEPLOYMENT_ID_ENV_KEY]: spec.rawDeploymentId,
        // WORKBENCH-LOCAL (CL-2199): single-agent tool identity the resolver's
        // stepCount === 1 branch keys the credential + hub-backed rails on.
        // Always populated (multi-step sets its deployment agent id + supervisor
        // principal, which the multi-step branch ignores); both are members of
        // SIDECAR_SUBSTRATE_CONFIG_KEYS so `assertSubstrateEnvComplete` requires
        // them non-empty and the child's `filterSubstrateConfig` lets them
        // through to the substrate factory.
        WORKFLOW_SINGLE_AGENT_ID: spec.agentId,
        WORKFLOW_SINGLE_AGENT_PRINCIPAL_ID: spec.instancePrincipalId,
      };

      // WORKBENCH-LOCAL (CL-2363): fail the deploy loudly if any
      // substrate-config key the workflow-child requires is missing, rather
      // than spawning a child that crashes at boot. The child receives the
      // static `substrateEnv` merged with the dynamic spawn-env fragment
      // (`STEP_INFERENCE_SOURCES`, recomputed per spawn/recycle), so the
      // completeness check runs over the UNION -- otherwise it would wrongly
      // flag STEP_INFERENCE_SOURCES, which is not in the static env.
      assertSubstrateEnvComplete({
        ...substrateEnv,
        [STEP_INFERENCE_SOURCES_ENV_KEY]: JSON.stringify(spec.sources),
      });
      // Live-rotatable per-step inference sources. Seeded from the deploy
      // spec, then revised in place by the single-step sources-rotation
      // handler below. `STEP_INFERENCE_SOURCES` is NOT in the frozen
      // `substrateEnv`: it is recomputed on every spawn and recycle respawn
      // via `dynamicSpawnEnv`, so a rotation survives a recycle instead of
      // reverting to the deploy-time list.
      let currentSources = spec.sources;

      const wired = createSidecarWorkflowSupervisor({
        transport: deps.transport,
        repoStore: deps.repoStore,
        signingKeySeed: deps.signingKeySeed,
        workflowRunRepoId: {
          kind: "workflow-run",
          id: deploymentId,
        },
        workflowRunRef: "refs/heads/main",
        deploymentId,
        stepCount: spec.definition.stepOrder.length,
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
        ...(deps.multistepBinaryPath !== undefined
          ? { binaryPath: deps.multistepBinaryPath }
          : {}),
        ...(deps.onDispatchTiming !== undefined
          ? { onDispatchTiming: deps.onDispatchTiming }
          : {}),
        ...(deps.repackEveryMessages !== undefined
          ? { repackEveryMessages: deps.repackEveryMessages }
          : {}),
        ...(deps.consumedRetentionMs !== undefined
          ? { consumedRetentionMs: deps.consumedRetentionMs }
          : {}),
        ...(deps.readyTimeoutMs !== undefined
          ? { readyTimeoutMs: deps.readyTimeoutMs }
          : {}),
      });

      // OUTBOUND half of mailbox ownership (§3a): register a signing key for
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
      // Warm-keep is the single-step launched-agent deploy: the sole step
      // IS the long-lived agent, so the child warm-keeps it across
      // messages. A multi-step deploy keeps instantiate-send-teardown per
      // step. The signal is carried explicitly down through the spawn env.
      const warmKeep = spec.definition.stepOrder.length === 1;
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
          publishInferenceEvent(spec.agentAddress, validated, spec.sessionId);
          // WORKBENCH-LOCAL (CL-3340): assistant loop guard, re-homed onto
          // this seam (see assistant-loop-guard-wiring.ts). Scoped to
          // `warmKeep` (the single long-lived interactive agent) --
          // multi-step deployments can run independent steps concurrently
          // on the same agent address, and this guard's single-turn
          // contract assumes one serial dispatch loop per key.
          if (warmKeep) {
            observeInferenceEventForAssistantLoopGuard(validated, {
              guard: assistantLoopGuard,
              sessionKey: spec.agentAddress,
              publish: (loopEvent) => {
                publishInferenceEvent(
                  spec.agentAddress,
                  loopEvent,
                  spec.sessionId,
                );
              },
              drain: (deadlineMs) => wired.supervisor.drain({ deadlineMs }),
            });
          }
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
      // WORKBENCH-LOCAL (CL-2231): not in upstream — preserve on pin-bump
      // re-sync. Capture the deployment's on-disk footprint so the undeploy
      // hook can reclaim it regardless of whether the step agents are still
      // connected. The workflow-run repo dir comes straight from the
      // substrate's pure `getRepoDir` path computation; the per-step dirs are
      // derived from `stepOrder` via the SAME `stepStrategy.deriveStepRepoId` /
      // `deriveStepAddress` the supervisor used, keyed by the SAME slug
      // `deploymentId` -- so the dirs reclaimed here are exactly the ones the
      // supervisor created on disk. Every spawn routes through here (the
      // deploy path; there is no boot-time restore), so the reclaim set is
      // always complete.
      const ownedDirs: string[] = [
        deps.repoStore.getRepoDir({ kind: "workflow-run", id: deploymentId }),
      ];
      for (const stepId of spec.definition.stepOrder) {
        ownedDirs.push(
          deps.repoStore.getRepoDir(
            stepStrategy.deriveStepRepoId({ deploymentId, stepId }),
          ),
        );
        if (stepStateDataDir !== undefined) {
          const stepAddress = stepStrategy.deriveStepAddress({
            deploymentId,
            stepId,
          });
          ownedDirs.push(
            pathJoin(stepStateDataDir, sanitizeAddress(stepAddress)),
          );
        }
      }
      activeSupervisors.set(spec.agentAddress, { wired, ownedDirs });
      supervisorRegistered = true;

      // Bind the deployment's mail address to this supervisor's
      // `routeInbound` so the hub-link dispatches inbound mail into the
      // supervisor's mail-bus subscription. Registration happens after
      // `spawn` succeeds so a spawn-time rejection leaves the registry
      // untouched.
      deps.multistepMailRouter?.register(spec.agentAddress, (message) => {
        // WORKBENCH-LOCAL (CL-3340): every inbound message starts a fresh
        // turn for the guard's single-turn contract -- reset before
        // forwarding so a new user message never inherits the prior turn's
        // repeat count.
        if (warmKeep) assistantLoopGuard.reset(spec.agentAddress);
        wired.routeInbound(message);
      });
      // Register the signal-delivery handler so a hub `signal.deliver` frame
      // dispatches through the supervisor's `deliverSignal`.
      deps.multistepSignalRouter?.register(spec.agentAddress, async (args) => {
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
        await wired.supervisor.drain({ deadlineMs: args.deadlineMs });
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
            const rotated = { [rotationStepId]: args.sources };
            // Process-local respawn hint only (CL-3884): the sidecar keeps
            // no durable deployment record, so a rotation survives recycles
            // (the supervisor respawns the child from `currentSources`) but
            // not a full sidecar restart — the hub-driven re-deploy
            // re-resolves sources fresh, which is the native source of truth.
            currentSources = rotated;
            await wired.supervisor.deliverSources({
              sources: args.sources,
              defaultSource: args.defaultSource,
            });
          },
        );
      }
      routersRegistered = true;

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
          // Unregister unconditionally: the sources handler was registered
          // only for a single-step deploy, but `unregister` is a no-op for
          // an address that never registered one, so a multi-step unwind
          // safely calls it too.
          deps.multistepSourcesRouter?.unregister(spec.agentAddress);
        }
        if (supervisorRegistered) {
          activeSupervisors.delete(spec.agentAddress);
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

    // WORKBENCH-LOCAL (CL-3104): resident-supervisor self-heal. A hibernate
    // whose ack path failed leaves the hub believing the deployment is down
    // (interchange's undeploy timeout unroutes before rejecting) while the
    // child is still resident here; the wake then re-sends agent.deploy at the
    // live supervisor. Without this the fresh deploy would hit the
    // already-deployed throw (or, absent it, overwrite the activeSupervisors
    // entry and leak the resident child so two children drive one workflow-run
    // repo). Tear the resident supervisor down state-preservingly (hibernate
    // semantics — no rm) before standing the fresh one up. A concurrent
    // in-flight deploy (`reservingDeployAddresses`) is a genuine race, not a
    // resident child, so it still throws below.
    if (activeSupervisors.has(frame.agentAddress)) {
      logger.warn`deploy for ${frame.agentAddress} found a resident supervisor; shutting it down state-preservingly before re-deploying`;
      await teardownDeployment(frame.agentAddress, { reclaimDirs: false });
    }

    // Reject a re-deploy of an address mid-deploy in this process BEFORE
    // touching any durable state. The durable writes below (the restore
    // record, workflow.json, step grants) are destructive overwrites of state
    // owned by whatever deployment currently holds the address; overwriting is
    // only legal when this deploy owns the address.
    // `reservingDeployAddresses` catches an address whose deploy is still in
    // flight -- the map is populated only after `spawn` succeeds, so the
    // has-check alone leaves a window in which two frames both pass and the
    // loser's catch below deletes the winner's live record; the reservation
    // set closes it.
    if (reservingDeployAddresses.has(frame.agentAddress)) {
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
    // frame/in-memory-only inputs: sources, session id, single-step hub key).
    const spec: WorkflowDeploySpec = {
      agentAddress: frame.agentAddress,
      definition: projection.definition,
      sources: projection.sources,
      // WORKBENCH-LOCAL (CL-2199): tenant scope from the validated HarnessConfig
      // and raw hub deploymentId recovered from the deployment's INSTANCE ID
      // (`parseAgentId(frame.agentAddress)`), NOT the frame's `agentId` — a
      // single-agent frame carries the real `agt_<defId>` agentId, which has no
      // recoverable deploymentId. The address's instance id is `ins_<id>` for
      // both deploy families, so this stays identical to the prior
      // `deriveRawDeploymentId(frame.agentId)` for multi-step
      // (`parseAgentId(ins_<deploymentId>@domain) === frame.agentId`).
      tenantId: frame.config.tenantId,
      rawDeploymentId: deriveRawDeploymentId(parseAgentId(frame.agentAddress)),
      // WORKBENCH-LOCAL (CL-2199): single-agent tool identity. For a single
      // launched agent `frame.agentId` is the real `agt_<defId>` and
      // `frame.config.principalId` is its instance principal; the resolver's
      // single-agent branch keys the credential + hub-backed rails on them.
      agentId: frame.agentId,
      instancePrincipalId: frame.config.principalId,
      sessionId: frame.config.sessionId,
      hubPublicKey:
        projection.definition.stepOrder.length === 1
          ? frame.hubPublicKey
          : undefined,
    };

    claimSlug(deploymentId, frame.agentAddress);
    // Hold the single-flight reservation across the async body below and clear
    // it in the finally. Everything above is synchronous and throws before any
    // durable write, so the reservation is only needed from the first await
    // here onward; the top-of-method guard already consults this set for a
    // concurrent frame, and claimSlug/deploymentId derivation above cannot
    // yield control before this point.
    reservingDeployAddresses.add(frame.agentAddress);
    try {
      // Materialize the deploy-only durable state the spawned child and the
      // supervisor read from disk: the workflow definition (`workflow.json`)
      // and each step's grants. The restore path finds both already on disk
      // and skips this; both land before the shared spawn core runs.
      await materializeWorkflowJson(dataDir, projection.definition);

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
      // Soft failure (this process survived, the deploy threw): release the
      // slug so the failed deploy does not leak it. There is no durable
      // deployment record to clean up (CL-3884): the sidecar keeps no
      // deployment memory, so a crash-interrupted deploy leaves only run
      // state the hub-driven re-deploy (or the boot reconciler's dead-dir
      // reclaim) handles.
      releaseSlug(deploymentId, frame.agentAddress);
      throw cause;
    } finally {
      // Release the single-flight reservation whether the deploy succeeded or
      // threw. On success the address is now in `activeSupervisors`, which the
      // guard also consults, so a later re-deploy is still rejected.
      reservingDeployAddresses.delete(frame.agentAddress);
    }
  }

  // WORKBENCH-LOCAL (CL-3104): shared teardown body for `undeploy`
  // (reclaimDirs: true — forget the deployment entirely) and `hibernate`
  // (reclaimDirs: false — preserve every durable artifact so a parked
  // awaitSignal run resumes on wake). On a pin-bump re-sync, re-apply upstream
  // undeploy changes INSIDE this function, keeping the `reclaimDirs` gates
  // around the two rm sweeps and the record delete.
  async function teardownDeployment(
    agentAddress: string,
    opts: { reclaimDirs: boolean },
  ): Promise<void> {
    // Symmetric teardown for `deploy`: release the per-deployment routing
    // state so a stale `signal.deliver` / `drain.deliver` / `mail.inbound`
    // aimed at the dead deployment address is rejected by the router rather
    // than dispatched into an orphan supervisor handler. The unregister calls
    // are idempotent -- they are no-ops when no handler is registered.
    //
    // Routers come down BEFORE the supervisor's `shutdown()` so any hub-side
    // frame racing the teardown is dropped at the router boundary rather than
    // dispatched into a supervisor mid child-teardown.
    const deploymentId = deriveDeploymentId(agentAddress);
    // CL-3884: no tombstone, no dormant marker — the sidecar keeps no
    // deployment memory and never restores at boot, so there is nothing to
    // guard against resurrection and nothing to mark dormant. Hibernate
    // (reclaimDirs: false) simply tears residency down and preserves the
    // durable run state; the hub re-deploys on the next gate signal.
    deps.multistepMailRouter?.unregister(agentAddress);
    deps.multistepSignalRouter?.unregister(agentAddress);
    deps.multistepDrainRouter?.unregister(agentAddress);
    // Unregister unconditionally (a no-op for a multi-step address that
    // registered no sources handler), matching the sibling routers.
    deps.multistepSourcesRouter?.unregister(agentAddress);
    // WORKBENCH-LOCAL (CL-3340): drop the guard's run state so a churned
    // deployment address does not linger in its map beyond the
    // deployment's own lifetime (on top of the guard's own
    // DEFAULT_MAX_SESSIONS eviction). A no-op for an address the guard
    // never saw (multi-step, or a warmKeep deployment that never tripped).
    assistantLoopGuard.reset(agentAddress);
    // Shut the per-deployment supervisor down so the workflow-process child,
    // its IPC pipes, and its event-channel fd are released. The supervisor's
    // `shutdown()` is idempotent and handles the kill + `exited` await
    // internally. The map entry is removed before the await so a subsequent
    // re-deploy on the same address cannot observe a stale handle even if
    // `shutdown()` rejects.
    const active = activeSupervisors.get(agentAddress);
    if (active !== undefined) {
      activeSupervisors.delete(agentAddress);
      await active.wired.supervisor.shutdown();
      // WORKBENCH-LOCAL (CL-2340): not in upstream — preserve on pin-bump
      // re-sync. Barrier: drain the workflow-run pack-push pipeline to a
      // hub-acked resting state now that `shutdown()` guarantees the child
      // can append no more events. This MUST precede the reclaim rm below (a
      // push must not race the repo-dir deletion mid pack walk) AND the cursor
      // clear in `unregisterDeployment` (a push that acks after the cursor is
      // forgotten would resurrect a stale delta cursor → dangling-delta on
      // redeploy). Best-effort: a failed final push has already reset its own
      // cursor, so swallow. Runs for hibernate too — a drained resting state
      // is correct whether or not the durable dirs survive.
      if (deps.drainWorkflowRunPushes !== undefined) {
        try {
          await deps.drainWorkflowRunPushes(deploymentId);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          logger.warn`teardown: workflow-run push drain failed for ${agentAddress}: ${reason}`;
        }
      }
      // Drop the deployment address's transport registration installed at
      // spawn (OUTBOUND half of mailbox ownership, §3a). `unregister` is a
      // no-op only if the spawn failed before registering, so it is safe to
      // call unconditionally for any spawned deployment.
      deps.transport.unregister(agentAddress);
      // Reclaim the deployment's per-step local-disk scratch now that its
      // supervisor + workflow-process child are torn down. Awaiting
      // `shutdown()` above guarantees no child still holds the scratch. The
      // durable conversation under `agent-conversation-state/` is a DIFFERENT
      // root and is deliberately NOT touched here.
      // WORKBENCH-LOCAL (CL-3104): gated off for hibernate — a parked run's
      // per-step scratch (and warm workspace) must survive so the woken child
      // resumes against it.
      if (opts.reclaimDirs && stepStateDataDir !== undefined) {
        await rm(
          pathJoin(stepStateDataDir, "workflow-step-state", deploymentId),
          { recursive: true, force: true },
        );
      }

      // WORKBENCH-LOCAL (CL-2231): not in upstream — preserve on pin-bump
      // re-sync. Reclaim the deployment's on-disk footprint (workflow-run repo
      // dir + per-step agent-state/agent dirs). Deployment churn otherwise
      // leaks these and exhausts the sidecar volume's inodes. Each deletion is
      // best-effort and idempotent (`force: true` swallows ENOENT) and never
      // throws out of teardown.
      // WORKBENCH-LOCAL (CL-3104): gated off for hibernate — the workflow-run
      // repo IS the parked run's durable event log and the step agent-state
      // repos hold its grants; deleting either would turn the wake re-deploy
      // into a fresh run instead of a resume.
      if (opts.reclaimDirs) {
        for (const dir of active.ownedDirs) {
          try {
            await rm(dir, { recursive: true, force: true });
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            logger.warn`teardown: failed to reclaim deployment dir ${dir} for ${agentAddress}: ${reason}`;
          }
        }
      }
    }
    // Undeploy (reclaimDirs) with NO in-memory `active` supervisor: the
    // CL-2231 owned-dir reclaim above never ran, so the deployment's whole
    // `workflow-runs/<deploymentId>` directory (workflow-run substrate
    // included) would leak. Reclaim it directly. With an `active` supervisor
    // the directory is covered by its `ownedDirs` sweep. Hibernate
    // (reclaimDirs: false) keeps everything for the signal-driven resume.
    if (
      opts.reclaimDirs &&
      stepStateDataDir !== undefined &&
      active === undefined
    ) {
      await reclaimWorkflowDeploymentDir(stepStateDataDir, deploymentId);
    }
    releaseSlug(deploymentId, agentAddress);
    deps.unregisterDeployment({ deploymentId, agentAddress });
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
      await teardownDeployment(frame.agentAddress, { reclaimDirs: true });
    },
    // WORKBENCH-LOCAL (CL-3104): hibernate — the state-PRESERVING teardown
    // for a deployment whose only run is parked at an awaitSignal gate.
    // Identical residency teardown (routers, supervisor/child kill, drain
    // barrier, slug release, deployment mapping) but every durable on-disk
    // artifact survives: the workflow-run repo holding the parked run's event
    // log, each step's agent-state repo, the per-step scratch, the durable
    // conversation, AND the deployment record. A later re-deploy at the same
    // address (the hub's signal-path re-establishment) or a sidecar restart's
    // restore spawns a fresh child that resumes the parked run from that state.
    async hibernate(frame): Promise<void> {
      await teardownDeployment(frame.agentAddress, { reclaimDirs: false });
    },
    activeAddresses(): string[] {
      // `activeSupervisors` is keyed by deployment agent address and holds
      // exactly the deployments with a live supervisor (deploy and restore
      // add; undeploy and spawn-unwind remove), so its keys are the addresses
      // this sidecar can currently route mail to.
      return [...activeSupervisors.keys()];
    },
  };
}

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
 * Default max RSS for a workflow-process child before the supervisor
 * recycles it. 3 GiB sits above the legitimate warm-agent baseline for
 * a multi-step deployment holding several warm agents across a long
 * uptime -- a lower bound risks recycle thrashing against normal
 * steady-state memory rather than only catching a genuine runaway
 * child.
 *
 * Override with `WORKFLOW_CHILD_MAX_RSS_BYTES` (decimal bytes) or set
 * the env to `0` / empty to disable the bound.
 */
export const DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES = 3 * 1024 * 1024 * 1024;

export function resolveDefaultRecyclePolicy(): {
  maxRssBytes?: number;
} {
  const raw = process.env["WORKFLOW_CHILD_MAX_RSS_BYTES"];
  if (raw === undefined) {
    return { maxRssBytes: DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES };
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0") {
    return {};
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn`WORKFLOW_CHILD_MAX_RSS_BYTES=${raw} is not a positive number; using default ${String(DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES)}`;
    return { maxRssBytes: DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES };
  }
  return { maxRssBytes: Math.floor(n) };
}

/**
 * Whether a resolved recycle policy actually bounds RSS. A policy carrying
 * only `maxUptimeMs`/`maxGrantsAgeMs` never reads `readRssBytes`, so the
 * pid-tracking spawner wrapper (`createPidTrackingRssReader`) should only be
 * installed when this is true -- installing it for any non-empty policy
 * wraps the spawner on every spawn/recycle respawn for a reader nothing
 * consults.
 */
export function recyclePolicyWantsRssTracking(recyclePolicy: {
  maxRssBytes?: number;
}): boolean {
  return recyclePolicy.maxRssBytes !== undefined;
}

/**
 * Wraps a `SubprocessSpawner` so the supervisor's zero-arg
 * `readRssBytes` policy callback (`WorkflowSupervisorBindings.
 * readRssBytes` has no pid parameter) can still report the *current*
 * child's RSS. `subprocessSpawner` is invoked by the supervisor on
 * every spawn AND every recycle respawn, so tracking the pid at the
 * spawn call site keeps it current across the deployment's whole
 * lifetime without a separate hook into the recycle path.
 */
export function createPidTrackingRssReader(
  baseSpawner: SubprocessSpawner,
  readPidRssBytes: (pid: number) => number | undefined = readChildRssBytes,
): {
  spawner: SubprocessSpawner;
  readRssBytes: () => number | undefined;
} {
  let currentChildPid: number | undefined;
  const spawner: SubprocessSpawner = (spawnArgs) => {
    const handle = baseSpawner(spawnArgs);
    currentChildPid = handle.pid;
    return handle;
  };
  return {
    spawner,
    readRssBytes: () =>
      currentChildPid === undefined
        ? undefined
        : readPidRssBytes(currentChildPid),
  };
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
    deploymentId: opts.deploymentId,
  };
  const recyclePolicy = opts.recyclePolicy ?? resolveDefaultRecyclePolicy();
  const baseSpawner = opts.subprocessSpawner ?? defaultSubprocessSpawner;
  const wantsRssTracking = recyclePolicyWantsRssTracking(recyclePolicy);
  const { spawner: trackingSpawner, readRssBytes } = wantsRssTracking
    ? createPidTrackingRssReader(baseSpawner)
    : { spawner: baseSpawner, readRssBytes: undefined };
  const supervisor = createWorkflowSupervisor({
    repoStore: opts.repoStore,
    signAsPrincipal: async (kind, payload) => {
      const sig = await signEd25519(opts.signingKeySeed, payload);
      return { sig, principalKind: kind };
    },
    mailBus,
    subprocessSpawner: trackingSpawner,
    binaryPath: opts.binaryPath ?? SIDECAR_WORKFLOW_CHILD_BINARY,
    substrateEnv: opts.substrateEnv,
    dynamicSpawnEnv: opts.dynamicSpawnEnv,
    workflowRunRepoId: opts.workflowRunRepoId,
    workflowRunRef: opts.workflowRunRef,
    deploymentId: opts.deploymentId,
    stepCount: opts.stepCount,
    deploymentMailAddress: opts.deploymentMailAddress,
    readPrincipal: supervisorPrincipal,
    deriveStepAddress: opts.deriveStepAddress,
    ...(opts.deriveStepRepoId !== undefined
      ? { deriveStepRepoId: opts.deriveStepRepoId }
      : {}),
    deriveMailAuditRef: deriveSidecarMailAuditRef(opts.deploymentId),
    ...(opts.onDispatchTiming !== undefined
      ? { onDispatchTiming: opts.onDispatchTiming }
      : {}),
    ...(opts.repackEveryMessages !== undefined
      ? { repackEveryMessages: opts.repackEveryMessages }
      : {}),
    ...(opts.consumedRetentionMs !== undefined
      ? { consumedRetentionMs: opts.consumedRetentionMs }
      : {}),
    ...(opts.readyTimeoutMs !== undefined
      ? { readyTimeoutMs: opts.readyTimeoutMs }
      : {}),
    ...(Object.keys(recyclePolicy).length > 0
      ? { recyclePolicy, ...(wantsRssTracking ? { readRssBytes } : {}) }
      : {}),
  });
  return {
    supervisor,
    routeInbound(message) {
      mailBus.routeInbound(opts.deploymentMailAddress, message);
    },
    getCredentialsSnapshot: () => supervisor.getCredentialsSnapshot(),
  };
}
