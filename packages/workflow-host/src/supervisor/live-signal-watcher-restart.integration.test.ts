import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type } from "arktype";

import { generateKeyPair } from "@intx/crypto-node";
import type { KeyPair } from "@intx/types/runtime";
import type { AuthorizeFn, Principal, RepoId } from "@intx/hub-sessions";
import {
  createRepoStore,
  workflowRunKindHandler,
  WORKFLOW_RUN_GITIGNORE_PATH,
} from "@intx/hub-sessions";
import {
  assembleMessage,
  assembleSignedContent,
  type MessageHeaders,
} from "@intx/mime";
import type { WorkflowEvent } from "@intx/workflow";

import {
  createWorkflowSupervisor,
  type MailBusBindings,
  type SubprocessHandle,
  type SubprocessSpawner,
  type WorkflowSupervisorBindings,
} from "./index";
import {
  ControlPayload,
  SignedEnvelope,
  type NdjsonReader,
  type NdjsonWriter,
  type FrameReader,
} from "../ipc/index";
import {
  parseSpawnTimeEnv,
  runWorkflowChild,
  type RunWorkflowChildBindings,
  type RunWorkflowChildOpts,
  type RunWorkflowChildResult,
} from "../child/index";
import { createWorkflowRunRepoStore } from "../adapters/repo-store";

// CL-2537 SUPERVISOR-LEVEL integration test. The four existing CL-2537 tests
// (run-child.test.ts) drive `runWorkflowChild` directly — they never
// instantiate the supervisor, so the two load-bearing supervisor behaviours go
// unverified:
//
//   (A) UNWEDGE — a run parked at an awaitSignal gate leaves an orphaned
//       `processing/` entry. On restart `replayProcessingToInbox` re-queues it
//       and the strictly-serial dispatch loop re-fires `trigger.fire`, then
//       `waitForRunTerminal` BLOCKS on that runId until a terminal event. Does
//       the watcher path let a fresh run reach terminal (i.e. the loop is not
//       permanently wedged), given the parked run has no terminal until the
//       human signals?
//
//   (B) SINGLE-DRIVER — the watcher does NOT call `runtimeRun` at discovery, so
//       the supervisor's re-fired `trigger.fire(parkedRunId)` starts a SECOND
//       in-process driver alongside the watcher. When the signal lands, do BOTH
//       drive (duplicate StepCompleted / RunStarted / RunCompleted, a seq
//       conflict, or two upstream terminal.event frames)?
//
// To exercise the REAL components across their seams this test wires a REAL
// in-process `runWorkflowChild` to the REAL supervisor over in-memory IPC
// streams, sharing ONE real workflow-run substrate (`createRepoStore` +
// `workflowRunKindHandler`) and the production substrate-backed inbox
// primitives (NOT the in-memory stub). Runs are injected through the mail bus
// exactly as inbound mail arrives in production; the supervisor mints the
// claim-check `processing/` entry itself, and the child recovers the inbound
// bytes from it on `trigger.fire`.

const DEPLOYMENT_ID = "deployment-gate";
const ADDRESS = "deployment-gate@example.com";
const WORKFLOW_RUN_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: DEPLOYMENT_ID,
};
const WORKFLOW_DEFINITION_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: "gate-asset",
};

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- in-memory IPC streams (copied from the run-child/supervisor harnesses) ---

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
  return {
    reader,
    writer: {
      write(bytes: Uint8Array) {
        buffer.push(bytes);
        wake();
      },
    },
    close() {
      done = true;
      wake();
    },
  };
}

// --- mock mail bus (the production mail-bus seam the supervisor registers on) ---

function createMockMailBus(): MailBusBindings & {
  deliver(address: string, message: Uint8Array): void;
} {
  const subscribers = new Map<string, Set<(rawMessage: Uint8Array) => void>>();
  return {
    registerAddress() {},
    unregisterAddress(address: string) {
      subscribers.delete(address);
    },
    subscribeMailForAddress(
      address: string,
      handler: (rawMessage: Uint8Array) => void,
    ) {
      let set = subscribers.get(address);
      if (set === undefined) {
        set = new Set();
        subscribers.set(address, set);
      }
      set.add(handler);
      return () => {
        subscribers.get(address)?.delete(handler);
      };
    },
    sendOutbound() {
      throw new Error("sendOutbound not exercised in this test");
    },
    deliver(address: string, message: Uint8Array) {
      const set = subscribers.get(address);
      if (set === undefined) return;
      for (const handler of set) handler(message);
    },
  };
}

// --- a real conversation MIME message with a settable Message-ID ---

function buildConversationMessage(messageId: string, text: string): Uint8Array {
  const headers: MessageHeaders = {
    from: "user@example.com",
    to: [ADDRESS],
    cc: undefined,
    date: new Date(0),
    messageId,
    subject: undefined,
    inReplyTo: undefined,
    references: undefined,
    mimeVersion: "1.0",
    interchangeType: "conversation.message",
    interchangeCorrelationId: undefined,
    interchangeTenantId: undefined,
    interchangeAgentId: undefined,
    interchangeSessionId: undefined,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    traceparent: undefined,
    tracestate: undefined,
  };
  const signedContent = assembleSignedContent({ kind: "conversation", text });
  return assembleMessage(headers, signedContent, new Uint8Array([0]));
}

// --- gate workflow definition + recover hook (mirrors run-child.test.ts) ---

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

// Faithful in-test stand-in for apps/sidecar's recoverParkedRunFromLog (the
// production hook); packages/workflow-host cannot import from apps/sidecar.
function makeGateRecoverHook(): NonNullable<
  RunWorkflowChildOpts["recoverParkedRun"]
> {
  return async (run, ctx) => {
    const awaitedBySignal = new Map<string, string>();
    const attemptByStep = new Map<string, number>();
    const completed = new Set<string>();
    const received: { signalName: string; payload: unknown }[] = [];
    for (const event of run.seedEvents) {
      if (event.kind === "SignalAwaited") {
        awaitedBySignal.set(event.signalName, event.stepId);
      } else if (event.kind === "StepStarted") {
        attemptByStep.set(event.stepId, event.attempt);
      } else if (event.kind === "StepCompleted") {
        completed.add(event.stepId);
      } else if (event.kind === "SignalReceived") {
        received.push({
          signalName: event.signalName,
          payload: event.payload,
        });
      }
    }
    let seq = run.seedEvents.reduce((max, e) => Math.max(max, e.seq), 0);
    const appended: WorkflowEvent[] = [];
    const handled = new Set<string>();
    for (const signal of received) {
      const stepId = awaitedBySignal.get(signal.signalName);
      if (stepId === undefined) continue;
      if (completed.has(stepId) || handled.has(stepId)) continue;
      handled.add(stepId);
      const attempt = attemptByStep.get(stepId) ?? 1;
      const { ref } = await ctx.blobs.recordOutput(
        stepId,
        attempt,
        signal.payload,
      );
      seq += 1;
      appended.push({
        kind: "StepCompleted",
        seq,
        at: new Date().toISOString(),
        stepId,
        attempt,
        output: { ref },
      });
    }
    if (appended.length === 0) return null;
    return [...run.seedEvents, ...appended];
  };
}

// --- substrate genesis ---

async function genesisGateDeployment(baseDir: string): Promise<{
  substrate: WorkflowSupervisorBindings["repoStore"];
  principal: Principal;
}> {
  const signingKey: KeyPair = await generateKeyPair();
  const allowAll: AuthorizeFn = () => ({ allowed: true });
  const substrate = createRepoStore({
    dataDir: baseDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  const principalShape = {
    kind: "workflow-process",
    deploymentId: DEPLOYMENT_ID,
  };
  const principal: Principal = principalShape;
  await substrate.writeTree(
    { kind: "hub" },
    WORKFLOW_RUN_REPO_ID,
    "refs/heads/main",
    { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" }, message: "genesis" },
  );
  await substrate.writeTree(
    { kind: "hub" },
    WORKFLOW_DEFINITION_REPO_ID,
    "refs/heads/main",
    { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" }, message: "genesis" },
  );
  await seedGateWorkflowDir(substrate.getRepoDir(WORKFLOW_DEFINITION_REPO_ID));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- createRepoStore returns a RepoStore; WorkflowSupervisorBindings.repoStore is the same substrate seam (the run-child gate tests pass this verbatim as bindings.substrate)
  return {
    substrate: substrate as unknown as WorkflowSupervisorBindings["repoStore"],
    principal,
  };
}

// --- run-log readers (mirrors run-child.test.ts) ---

function readRunLog(
  substrate: WorkflowSupervisorBindings["repoStore"],
  principal: Principal,
  runId: string,
): Promise<readonly WorkflowEvent[]> {
  return createWorkflowRunRepoStore({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the adapter accepts the same RepoStore seam
    substrate: substrate as never,
    repoId: WORKFLOW_RUN_REPO_ID,
    principal,
    ref: "refs/heads/main",
  }).read(runId);
}

async function pollRunLog(
  substrate: WorkflowSupervisorBindings["repoStore"],
  principal: Principal,
  runId: string,
  predicate: (log: readonly WorkflowEvent[]) => boolean,
  label: string,
): Promise<readonly WorkflowEvent[]> {
  for (let i = 0; i < 1200; i += 1) {
    let log: readonly WorkflowEvent[] | null = null;
    try {
      log = await readRunLog(substrate, principal, runId);
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
    await delay(5);
  }
  throw new Error(`pollRunLog timed out: ${label}`);
}

function countKind(log: readonly WorkflowEvent[], kind: string): number {
  return log.filter((e) => e.kind === kind).length;
}

// --- control-frame parsers (validate through the canonical narrows) ---

function parseControlPayloads(
  lines: readonly string[],
): (typeof ControlPayload.infer)[] {
  const out: (typeof ControlPayload.infer)[] = [];
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const signed = SignedEnvelope(raw);
    if (signed instanceof type.errors) continue;
    const payload = ControlPayload(signed.envelope.payload);
    if (payload instanceof type.errors) continue;
    out.push(payload);
  }
  return out;
}

function triggerFireRunIds(lines: readonly string[]): string[] {
  return parseControlPayloads(lines)
    .filter((p) => p.type === "trigger.fire")
    .map((p) => (p.type === "trigger.fire" ? p.data.runId : ""));
}

function terminalEventRunIds(lines: readonly string[]): string[] {
  return parseControlPayloads(lines)
    .filter((p) => p.type === "terminal.event")
    .map((p) => (p.type === "terminal.event" ? p.data.runId : ""));
}

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  attempts = 1200,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`waitForCondition timed out: ${label}`);
}

// Faithfully simulate a subprocess death. The production workflow-child is a
// separate OS process: a sidecar restart KILLS it, so its in-flight
// `runtimeRun` coroutines (and their signal-channel `subscribe` tails on the
// shared in-memory substrate) cease to exist and can no longer commit. The
// in-process harness runs every child in ONE JS process over ONE shared
// substrate instance, so a "killed" child1's parked `awaitSignal` subscription
// would otherwise linger, wake on child2's later signal delivery, and commit a
// stale-seq `SignalReceived` — a single-writer seq conflict that has no
// production analogue. This wrapper combines each `subscribe` call's signal with
// a per-child kill signal fired when the child's `runWorkflowChild` resolves, so
// a dead child's substrate subscriptions tear down exactly as an OS kill would.
function wrapKillableSubstrate<T extends object>(
  substrate: T,
  killSignal: AbortSignal,
): T {
  return new Proxy(substrate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "subscribe" || typeof value !== "function") return value;
      const original = value as (
        principal: unknown,
        repoId: unknown,
        ref: unknown,
        opts: { signal: AbortSignal; from: unknown; bufferLimit?: number },
      ) => AsyncIterableIterator<unknown>;
      return (
        principal: unknown,
        repoId: unknown,
        ref: unknown,
        opts: { signal: AbortSignal; from: unknown; bufferLimit?: number },
      ) =>
        original.call(target, principal, repoId, ref, {
          ...opts,
          signal: AbortSignal.any([opts.signal, killSignal]),
        });
    },
  });
}

// --- in-process child spawner: each spawn runs the REAL runWorkflowChild
//     wired to in-memory IPC, capturing both directions of the control channel.

type SpawnRecord = {
  supervisorOutbound: string[]; // supervisor -> child (trigger.fire, signal.deliver, ...)
  childOutbound: string[]; // child -> supervisor (ready, terminal.event)
  exited: Promise<number>;
  child: Promise<RunWorkflowChildResult>;
};

function createInProcessChildSpawner(opts: {
  substrate: WorkflowSupervisorBindings["repoStore"];
  principal: Principal;
  recover: NonNullable<RunWorkflowChildOpts["recoverParkedRun"]>;
}): { spawner: SubprocessSpawner; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  let pid = 1000;
  const spawner: SubprocessSpawner = ({ env }) => {
    const s2c = createMemoryNdjsonStream();
    const c2s = createMemoryNdjsonStream();
    const evt = createMemoryFrameStream();
    const supervisorOutbound: string[] = [];
    const childOutbound: string[] = [];

    const supervisorControlWriter: NdjsonWriter = {
      write(line: string) {
        supervisorOutbound.push(line.replace(/\n$/, ""));
        s2c.writer.write(line);
      },
    };
    const childControlWriter: NdjsonWriter = {
      write(line: string) {
        childOutbound.push(line.replace(/\n$/, ""));
        c2s.writer.write(line);
      },
    };

    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    // Per-child kill signal: fired when this child's runWorkflowChild settles
    // (the in-process stand-in for the subprocess exiting), severing its
    // substrate subscriptions so a torn-down child cannot wake and commit.
    const killController = new AbortController();
    const childBindings: RunWorkflowChildBindings = {
      substrate: wrapKillableSubstrate(
        opts.substrate,
        killController.signal,
      ) as never,
      workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
      workflowRunRef: "refs/heads/main",
      principal: opts.principal,
      workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
      workflowDefinitionRef: "refs/heads/main",
      invokeStep: async () => ({ output: null }),
      spawnChild: async () => ({ terminalStatus: "completed" }),
      scheduler: { scheduleIn: () => () => undefined },
      evaluateGrants: async () => ({
        effect: "allow" as const,
        matchingGrants: [],
        resolvedBy: null,
      }),
      ipcChildKeyPairFactory: () => generateKeyPair(),
      initialCredentialsSnapshot: {
        steps: [
          {
            stepId: "gate",
            address: "deployment-gate-gate@example.com",
            grants: [],
            contentHash: "deadbeef",
          },
        ],
      },
    };

    const child = runWorkflowChild({
      env: parseSpawnTimeEnv(env),
      controlReader: s2c.reader,
      controlWriter: childControlWriter,
      eventWriter: evt.writer,
      bindings: childBindings,
      recoverParkedRun: opts.recover,
    }).finally(() => {
      killController.abort();
      resolveExit(0);
    });
    void child.catch(() => undefined);

    spawns.push({ supervisorOutbound, childOutbound, exited, child });

    const handle: SubprocessHandle = {
      pid: pid++,
      controlWriter: supervisorControlWriter,
      controlReader: c2s.reader,
      eventReader: evt.reader,
      kill: () => {
        s2c.close();
        evt.close();
        c2s.close();
      },
      exited,
    };
    return handle;
  };
  return { spawner, spawns };
}

function buildSupervisorBindings(opts: {
  substrate: WorkflowSupervisorBindings["repoStore"];
  spawner: SubprocessSpawner;
  mailBus: MailBusBindings;
  baseDir: string;
}): WorkflowSupervisorBindings {
  return {
    repoStore: opts.substrate,
    signAsPrincipal: (kind) => ({
      sig: new Uint8Array(64),
      principalKind: kind,
    }),
    mailBus: opts.mailBus,
    subprocessSpawner: opts.spawner,
    binaryPath: "/fake/bin/workflow-child",
    substrateEnv: { DATA_DIR: opts.baseDir },
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: "refs/heads/main",
    deploymentId: DEPLOYMENT_ID,
    deploymentMailAddress: ADDRESS,
    readPrincipal: { kind: "supervisor" },
    deriveStepAddress: ({ deploymentId, stepId }) =>
      `${deploymentId}-${stepId}@example.com`,
    // Keep step-grant resolution on the registered `workflow-run` kind (the
    // real substrate has no `agent-state` handler); no grants file exists at
    // this repo, so assembleCredentialsSnapshot resolves to empty grants.
    deriveStepRepoId: ({ deploymentId, stepId }) => ({
      kind: "workflow-run",
      id: `${deploymentId}-${stepId}-grants`,
    }),
    trivialLaunch: () => {
      throw new Error("trivialLaunch not used in this test");
    },
    // inboxPrimitives intentionally OMITTED -> the supervisor uses the
    // production substrate-backed @intx/hub-sessions implementations.
  };
}

describe("CL-2537 supervisor-level live awaitSignal watcher (restart + unwedge)", () => {
  test("a HITL run parked across a sidecar restart: the dispatch loop unwedges and the parked run is driven by exactly one driver", async () => {
    const baseDir = await makeTempDir("cl2537-supervisor-restart-");
    const { substrate, principal } = await genesisGateDeployment(baseDir);
    const mailBus = createMockMailBus();
    const { spawner, spawns } = createInProcessChildSpawner({
      substrate,
      principal,
      recover: makeGateRecoverHook(),
    });
    const bindings = buildSupervisorBindings({
      substrate,
      spawner,
      mailBus,
      baseDir,
    });

    // === Phase 1: start a run; let it park at the awaitSignal gate. ===
    const supervisor1 = createWorkflowSupervisor(bindings);
    await supervisor1.spawn({
      stepOrder: ["gate"],
      definitionHash: "definition-hash-abc",
      warmKeep: false,
      onInferenceEvent: () => {},
    });

    mailBus.deliver(
      ADDRESS,
      buildConversationMessage("<parked@example.com>", "kick off parked"),
    );

    // The supervisor's dispatch loop dequeues the inbound mail (minting the
    // claim-check processing entry the child reads) and fires trigger.fire.
    await waitForCondition(
      () => triggerFireRunIds(spawns[0]!.supervisorOutbound).length >= 1,
      "phase1 trigger.fire fired",
    );
    const firedParked = triggerFireRunIds(spawns[0]!.supervisorOutbound);
    const runIdParked = firedParked[0]!;

    // The run reaches the gate and parks: SignalAwaited tail, no terminal.
    const parkedTail = await pollRunLog(
      substrate,
      principal,
      runIdParked,
      (log) => log.some((e) => e.kind === "SignalAwaited"),
      "phase1 parked at gate",
    );
    expect(countKind(parkedTail, "RunCompleted")).toBe(0);
    expect(countKind(parkedTail, "RunStarted")).toBe(1);

    // An orphaned processing/ entry exists (the dispatch loop is blocked on
    // waitForRunTerminal(runIdParked) and never reached markConsumed).
    const processingDir = path.join(
      substrate.getRepoDir(WORKFLOW_RUN_REPO_ID),
      "addresses",
      encodeURIComponent(ADDRESS),
      "processing",
    );
    const processingEntries = await fs.readdir(processingDir);
    expect(processingEntries.length).toBeGreaterThanOrEqual(1);

    // === Phase 2: simulate a sidecar restart (teardown + fresh supervisor). ===
    // shutdown aborts the wedged dispatch loop + tears the child down; the
    // fresh supervisor spawns a new child that runs self-discovery and
    // replayProcessingToInbox over the SAME (persistent) substrate.
    await supervisor1.shutdown();
    await spawns[0]!.exited;

    const supervisor2 = createWorkflowSupervisor(bindings);
    await supervisor2.spawn({
      stepOrder: ["gate"],
      definitionHash: "definition-hash-abc",
      warmKeep: false,
      onInferenceEvent: () => {},
    });

    // replayProcessingToInbox re-queued the orphan; the new dispatch loop
    // re-fires trigger.fire for the SAME parked runId (the double-drive setup:
    // the child also discovered it at startup and installed a live watcher).
    await waitForCondition(
      () =>
        triggerFireRunIds(spawns[1]!.supervisorOutbound).includes(runIdParked),
      "phase2 re-fired trigger.fire for the parked run",
    );

    // === (A) probe — is the loop permanently wedged behind the parked run? ===
    // Deliver a fresh run. It queues BEHIND the replayed parked run (earlier
    // receivedAt), so a strictly-serial loop will not dispatch it until the
    // parked run terminates. Record whether it leapfrogs (it should not).
    mailBus.deliver(
      ADDRESS,
      buildConversationMessage("<fresh@example.com>", "kick off fresh"),
    );
    await delay(250);
    const firedBeforeParkedSignal = triggerFireRunIds(
      spawns[1]!.supervisorOutbound,
    ).filter((id) => id !== runIdParked);
    const freshLeapfrogged = firedBeforeParkedSignal.length > 0;

    // === (B) deliver the human signal for the PARKED run. ===
    await supervisor2.deliverSignal({
      runId: runIdParked,
      signalName: "go",
      signalId: "sig-parked-1",
      payload: { approved: true },
    });

    const parkedFinal = await pollRunLog(
      substrate,
      principal,
      runIdParked,
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "parked run resumed -> RunCompleted",
    );

    // (B) SINGLE-DRIVER: exactly one of each — a double-drive would show a
    // second RunStarted/StepCompleted/RunCompleted or a seq-conflict gap.
    expect(countKind(parkedFinal, "RunCompleted")).toBe(1);
    expect(countKind(parkedFinal, "RunFailed")).toBe(0);
    expect(countKind(parkedFinal, "StepCompleted")).toBe(1);
    expect(countKind(parkedFinal, "SignalReceived")).toBe(1);
    expect(countKind(parkedFinal, "RunStarted")).toBe(1);

    // The upstream terminal.event frame for the parked run is emitted exactly
    // once (this is what unwedges the supervisor's dispatch loop).
    await waitForCondition(
      () =>
        terminalEventRunIds(spawns[1]!.childOutbound).filter(
          (id) => id === runIdParked,
        ).length >= 1,
      "parked terminal.event emitted upstream",
    );
    await delay(60);
    expect(
      terminalEventRunIds(spawns[1]!.childOutbound).filter(
        (id) => id === runIdParked,
      ).length,
    ).toBe(1);

    // === (A) UNWEDGE: with the parked run terminal, the loop advances and the
    //     fresh run dispatches; signalling it drives it to terminal too. ===
    await waitForCondition(
      () =>
        triggerFireRunIds(spawns[1]!.supervisorOutbound).some(
          (id) => id !== runIdParked,
        ),
      "fresh run dispatched after parked run completed",
    );
    const runIdFresh = triggerFireRunIds(spawns[1]!.supervisorOutbound).find(
      (id) => id !== runIdParked,
    )!;

    await pollRunLog(
      substrate,
      principal,
      runIdFresh,
      (log) => log.some((e) => e.kind === "RunStarted"),
      "fresh run RunStarted",
    );
    await supervisor2.deliverSignal({
      runId: runIdFresh,
      signalName: "go",
      signalId: "sig-fresh-1",
      payload: { approved: true },
    });
    const freshFinal = await pollRunLog(
      substrate,
      principal,
      runIdFresh,
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "fresh run -> RunCompleted",
    );
    expect(countKind(freshFinal, "RunCompleted")).toBe(1);

    await supervisor2.shutdown();
    const child2Result = await spawns[1]!.exited.then(() => spawns[1]!.child);

    // The leapfrog observation: a strictly-serial loop holds the fresh run
    // behind the parked run until the parked run terminates, so this is
    // expected to be false (the loop did NOT dispatch the fresh run before the
    // parked run was signalled).
    expect(freshLeapfrogged).toBe(false);

    // === (B) DECISIVE DOUBLE-DRIVE GATE ===
    // The committed-log + terminal.event-once assertions above prove the
    // OUTCOME is contained, but they do NOT prove the watcher is the SOLE
    // driver. After a restart the supervisor's dispatch loop re-fires
    // trigger.fire for the SAME parked runId (replayProcessingToInbox put it
    // back in the inbox), and the child's trigger.fire handler
    // (run-child.ts:1018) UNCONDITIONALLY starts a second runtimeRun for that
    // runId — it has no dedup against the live watcher installed by
    // self-discovery. That second driver is recorded in `triggeredRunIds`
    // (run-child.ts:1043) regardless of whether its append later loses the
    // single-writer seq race. A watcher that were the sole driver would NOT
    // have the parked runId in `triggeredRunIds`.
    //
    // This assertion is the decision: it FAILS today, surfacing the missing
    // dedup guard. The double-drive is currently neutralised only by two
    // incidental safety nets — the substrate's single-writer seq-conflict guard
    // rejecting the loser's appends, and trigger.fire calling emitTerminalEvent
    // only on `handle.complete` RESOLVE (run-child.ts:1031-1042), so the failed
    // second driver emits no upstream terminal.event. Both fire a noisy
    // ERR-level "seq conflict ... single-writer invariant violated" log per
    // restart-with-parked-run. The fix is a real dedup: when self-discovery
    // installs a watcher for a runId, the child must treat a subsequent
    // trigger.fire for that runId as a no-op (the watcher owns the run and its
    // terminal.event still unwedges the dispatch loop).
    expect(child2Result.triggeredRunIds).not.toContain(runIdParked);
  }, 60_000);
});
