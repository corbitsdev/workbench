// Pins the native awaitSignal resume the vendor now depends on. The workbench
// fork previously carried a host-driven parked-run recovery (a recoverParkedRun
// hook + a live signal watcher) because the older runtime rejected an
// awaiting-signal tail on resume with RuntimeResumeUnsupportedError, wedging the
// supervisor's dispatch loop. The upstream runtime now re-offers those gates
// natively (isResumableAwaitingSignalStep / isResumableReceivedAwaitSignalStep
// in @intx/workflow's dag.ts + run.ts resume guard), so the fork blocks were
// dropped. These tests hold the child ⇄ runtime ⇄ real-substrate seam to that
// contract: an untimed gate parked at restart re-parks and completes on a signal
// delivered AFTER restart, and a crash-after-SignalReceived gate short-circuits
// to completion with no live deliver. If a future bump regresses the native
// carve-out, these fail instead of a parked run silently wedging in production.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import { hexEncode } from "@intx/types";
import type { KeyPair } from "@intx/types/runtime";
import type { AuthorizeFn, Principal, RepoId, RepoStore } from "@intx/hub-sessions";
import {
  createRepoStore,
  workflowRunKindHandler,
  WORKFLOW_RUN_GITIGNORE_PATH,
} from "@intx/hub-sessions";
import type { WorkflowEvent } from "@intx/workflow";

import { createWorkflowRunRepoStore } from "../adapters/repo-store";
import {
  parseSpawnTimeEnv,
  runWorkflowChild,
  type RunWorkflowChildBindings,
} from "./index";
import {
  createControlChannelSender,
  generateChannelId,
  generateHmacKey,
  type FrameReader,
  type FrameWriter,
  type NdjsonReader,
  type NdjsonWriter,
} from "../ipc/index";

const GATE_DEPLOYMENT_ID = "deployment-gate";
const PARKED_AT = "2026-01-01T00:00:00.000Z";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createMemoryNdjsonStream() {
  const buffer: string[] = [];
  let waiter: (() => void) | null = null;
  let done = false;
  function wake() {
    const w = waiter;
    waiter = null;
    if (w) w();
  }
  const reader: NdjsonReader = {
    read(): AsyncIterableIterator<string> {
      return (async function* () {
        while (true) {
          if (buffer.length > 0) {
            const next = buffer.shift();
            if (next === undefined) {
              throw new Error("buffer shift returned undefined");
            }
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      })();
    },
  };
  const writer: NdjsonWriter = {
    write(line: string) {
      buffer.push(line.replace(/\n$/, ""));
      wake();
    },
  };
  return {
    writer,
    reader,
    close() {
      done = true;
      wake();
    },
  };
}

function createMemoryFrameStream() {
  const buffer: Uint8Array[] = [];
  let waiter: (() => void) | null = null;
  let done = false;
  function wake() {
    const w = waiter;
    waiter = null;
    if (w) w();
  }
  const reader: FrameReader = {
    read(): AsyncIterableIterator<Uint8Array> {
      return (async function* () {
        while (true) {
          if (buffer.length > 0) {
            const next = buffer.shift();
            if (next === undefined) {
              throw new Error("frame buffer shift returned undefined");
            }
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      })();
    },
  };
  const writer: FrameWriter = {
    write(bytes: Uint8Array) {
      buffer.push(bytes);
      wake();
    },
  };
  return {
    reader,
    writer,
    close() {
      done = true;
      wake();
    },
  };
}

function makeGateSpawnEnv(opts: {
  channelId: string;
  hmacKeyHex: string;
  hostPubKeyHex: string;
}): Record<string, string> {
  return {
    IPC_CHANNEL_ID: opts.channelId,
    IPC_HMAC_KEY: opts.hmacKeyHex,
    HOST_PUBKEY: opts.hostPubKeyHex,
    DEPLOYMENT_ID: GATE_DEPLOYMENT_ID,
    DEFINITION_HASH: "definition-hash-abc",
    MAILBOX_ADDRESS: `${GATE_DEPLOYMENT_ID}@example.com`,
    STEP_COUNT: "1",
  };
}

async function seedGateWorkflowDir(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "workflow.json"),
    JSON.stringify({
      id: "gate-workflow",
      triggers: [{ type: "manual" }],
      steps: {
        gate: {
          kind: "awaitSignal",
          id: "gate",
          name: "go",
          drainBehavior: "wait",
        },
      },
      stepOrder: ["gate"],
    }),
  );
}

async function genesisGateDeployment(baseDir: string): Promise<{
  substrate: RepoStore;
  principal: Principal;
  workflowRunRepoId: RepoId;
  workflowDefinitionRepoId: RepoId;
}> {
  const signingKey: KeyPair = await generateKeyPair();
  const allowAll: AuthorizeFn = () => ({ allowed: true });
  const substrate = createRepoStore({
    dataDir: baseDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  const workflowRunRepoId: RepoId = {
    kind: "workflow-run",
    id: GATE_DEPLOYMENT_ID,
  };
  const workflowDefinitionRepoId: RepoId = {
    kind: "workflow-run",
    id: "gate-asset",
  };
  const principalShape = {
    kind: "workflow-process",
    deploymentId: GATE_DEPLOYMENT_ID,
  };
  const principal: Principal = principalShape;
  await substrate.writeTree({ kind: "hub" }, workflowRunRepoId, "refs/heads/main", {
    files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
    message: "genesis",
  });
  await substrate.writeTree(
    { kind: "hub" },
    workflowDefinitionRepoId,
    "refs/heads/main",
    { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" }, message: "genesis" },
  );
  await seedGateWorkflowDir(substrate.getRepoDir(workflowDefinitionRepoId));
  return { substrate, principal, workflowRunRepoId, workflowDefinitionRepoId };
}

function buildGateBindings(opts: {
  substrate: RepoStore;
  principal: Principal;
  workflowRunRepoId: RepoId;
  workflowDefinitionRepoId: RepoId;
  childKeyPair: KeyPair;
}): RunWorkflowChildBindings {
  return {
    substrate: opts.substrate,
    workflowRunRepoId: opts.workflowRunRepoId,
    workflowRunRef: "refs/heads/main",
    principal: opts.principal,
    workflowDefinitionRepoId: opts.workflowDefinitionRepoId,
    workflowDefinitionRef: "refs/heads/main",
    // awaitSignal gates never invoke an agent, so the step invoker is never
    // called for a gate-only workflow.
    invokeStep: async () => ({ output: null }),
    spawnChild: async () => ({ terminalStatus: "completed" }),
    scheduler: { scheduleIn: () => () => undefined },
    evaluateGrants: async () => ({
      effect: "allow" as const,
      matchingGrants: [],
      resolvedBy: null,
    }),
    ipcChildKeyPairFactory: () => Promise.resolve(opts.childKeyPair),
    initialCredentialsSnapshot: {
      steps: [
        {
          stepId: "gate",
          address: `${GATE_DEPLOYMENT_ID}@example.com`,
          grants: [],
          contentHash: "deadbeef",
        },
      ],
    },
  };
}

// Commit a run parked at the gate through the SAME adapter the runtime body
// writes with, so both the working-tree `read` path and the committed
// `subscribeKind` tail see it — the durable shape a sidecar restart leaves.
async function commitParkedRun(
  substrate: RepoStore,
  principal: Principal,
  workflowRunRepoId: RepoId,
  runId: string,
  extraEvents: readonly WorkflowEvent[] = [],
): Promise<void> {
  const runRepoStore = createWorkflowRunRepoStore({
    substrate,
    repoId: workflowRunRepoId,
    principal,
    ref: "refs/heads/main",
  });
  await runRepoStore.appendBatch(runId, [
    {
      kind: "RunStarted",
      seq: 1,
      at: PARKED_AT,
      runId,
      definitionHash: "h",
      trigger: { type: "manual", payload: null },
    },
    {
      kind: "StepStarted",
      seq: 2,
      at: PARKED_AT,
      stepId: "gate",
      attempt: 1,
      input: { ref: "inline:null" },
    },
    {
      kind: "SignalAwaited",
      seq: 3,
      at: PARKED_AT,
      stepId: "gate",
      signalName: "go",
    },
    ...extraEvents,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the state-machine WorkflowEvent union is narrowed downstream by the runtime; these literals match the runtime's own append shape
  ] as unknown as WorkflowEvent[]);
}

function readRunLog(
  substrate: RepoStore,
  principal: Principal,
  workflowRunRepoId: RepoId,
  runId: string,
): Promise<readonly WorkflowEvent[]> {
  return createWorkflowRunRepoStore({
    substrate,
    repoId: workflowRunRepoId,
    principal,
    ref: "refs/heads/main",
  }).read(runId);
}

async function pollRunLog(
  substrate: RepoStore,
  principal: Principal,
  workflowRunRepoId: RepoId,
  runId: string,
  predicate: (log: readonly WorkflowEvent[]) => boolean,
  label: string,
): Promise<readonly WorkflowEvent[]> {
  for (let i = 0; i < 600; i += 1) {
    let log: readonly WorkflowEvent[] | null = null;
    try {
      log = await readRunLog(substrate, principal, workflowRunRepoId, runId);
    } catch (cause) {
      if (
        cause === null ||
        typeof cause !== "object" ||
        (cause as { code?: unknown }).code !== "ENOENT"
      ) {
        throw cause;
      }
    }
    if (log !== null && predicate(log)) return log;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`pollRunLog timed out: ${label}`);
}

function hasKind(log: readonly WorkflowEvent[], kind: string): boolean {
  return log.some((e) => e.kind === kind);
}

describe("native awaitSignal resume", () => {
  test("an untimed gate parked at restart re-parks and completes on a signal delivered after restart", async () => {
    const baseDir = await makeTempDir("gate-native-repark-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();

    const { substrate, principal, workflowRunRepoId, workflowDefinitionRepoId } =
      await genesisGateDeployment(baseDir);
    await commitParkedRun(substrate, principal, workflowRunRepoId, "run-parked");

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeGateSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildGateBindings({
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
      childKeyPair,
    });
    const supervisorSender = createControlChannelSender({
      privateKeySeed: supervisorKeyPair.privateKey,
      channelId,
      writer: supervisorToChild.writer,
    });

    const runPromise = runWorkflowChild({
      env,
      controlReader: supervisorToChild.reader,
      controlWriter: childToSupervisor.writer,
      eventWriter: eventStream.writer,
      bindings,
    });

    // The gate has no SignalReceived yet, so the natively re-parked awaiter must
    // still be waiting. Deliver the signal AFTER the child booted and re-parked.
    await supervisorSender.send({
      type: "signal.deliver",
      data: {
        runId: "run-parked",
        signalName: "go",
        signalId: "sig-1",
        payload: { approved: true },
      },
    });

    await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
      (log) => hasKind(log, "RunCompleted"),
      "run-parked reaches RunCompleted after the post-restart signal",
    );

    await supervisorSender.send({ type: "shutdown", data: { reason: "done" } });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.resumedRunIds).toContain("run-parked");
  });

  test("a crash-after-SignalReceived gate short-circuits to completion with no live deliver", async () => {
    const baseDir = await makeTempDir("gate-native-received-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();

    const { substrate, principal, workflowRunRepoId, workflowDefinitionRepoId } =
      await genesisGateDeployment(baseDir);
    // The signal was already durably received before the crash; the gate is
    // in-flight awaiting only its StepCompleted. No live deliver follows.
    await commitParkedRun(substrate, principal, workflowRunRepoId, "run-received", [
      {
        kind: "SignalReceived",
        seq: 4,
        at: PARKED_AT,
        stepId: "gate",
        signalName: "go",
        signalId: "sig-pre",
        payload: { approved: true },
      } as unknown as WorkflowEvent,
    ]);

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeGateSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildGateBindings({
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
      childKeyPair,
    });
    const supervisorSender = createControlChannelSender({
      privateKeySeed: supervisorKeyPair.privateKey,
      channelId,
      writer: supervisorToChild.writer,
    });

    const runPromise = runWorkflowChild({
      env,
      controlReader: supervisorToChild.reader,
      controlWriter: childToSupervisor.writer,
      eventWriter: eventStream.writer,
      bindings,
    });

    await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-received",
      (log) => hasKind(log, "RunCompleted"),
      "run-received short-circuits to RunCompleted from the logged SignalReceived",
    );

    await supervisorSender.send({ type: "shutdown", data: { reason: "done" } });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.resumedRunIds).toContain("run-received");
  });
});
