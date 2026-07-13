import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import { base64Encode, hexEncode } from "@intx/types";
import type { KeyPair } from "@intx/types/runtime";
import type {
  AuthorizeFn,
  Principal,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions";
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

import {
  createWorkflowStepInvoker,
  type StepEnvBase,
} from "../adapters/step-invoker";
import { createWorkflowRunRepoStore } from "../adapters/repo-store";
import { createDefaultDirectorRegistry } from "@intx/agent";
import type { WorkflowEvent } from "@intx/workflow";
import { noopAuditStore } from "@intx/agent/testing";
import type { Agent, SendResult } from "@intx/agent";
import type {
  BlobReader,
  ContextStore,
  InboundMessage,
  InferenceSource,
} from "@intx/types/runtime";

import {
  parseSpawnTimeEnv,
  runWorkflowChild,
  type ChildStepInvoker,
  type RunWorkflowChildBindings,
  type RunWorkflowChildOpts,
} from "./index";
import {
  createControlChannelSender,
  generateChannelId,
  generateHmacKey,
  receiveControlChannel,
  receiveEventChannel,
  type FrameReader,
  type FrameWriter,
  type NdjsonReader,
  type NdjsonWriter,
} from "../ipc/index";

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
    inject(line: string) {
      buffer.push(line.replace(/\n$/, ""));
      wake();
    },
    flushed(): readonly string[] {
      return buffer.slice();
    },
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
    flushed(): readonly Uint8Array[] {
      return buffer.slice();
    },
    close() {
      done = true;
      wake();
    },
  };
}

function createStubRepoStore(baseDir: string): RepoStore {
  const stub: Partial<RepoStore> = {
    getRepoDir(repoId: RepoId): string {
      return path.join(baseDir, repoId.kind, repoId.id);
    },
    async writeTreePreservingPrefix(_principal, _repoId, _ref, _args) {
      return { commitSha: "deadbeefcafef00d", newlyTerminalRuns: [] };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; missing methods surface as a precise failure via the proxy
  return new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(
          `stub RepoStore: ${String(prop)} not implemented for this test`,
        );
      };
    },
  });
}

async function seedWorkflowDefinition(
  baseDir: string,
  repoId: RepoId,
): Promise<void> {
  const dir = path.join(baseDir, repoId.kind, repoId.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "workflow.json"),
    JSON.stringify({
      id: "test-workflow",
      triggers: [],
      steps: {},
      stepOrder: [],
    }),
  );
}

async function seedTriggerPayloadWorkflow(
  baseDir: string,
  stepId: string,
): Promise<void> {
  const repoId: RepoId = { kind: "workflow", id: "workflow-asset" };
  const dir = path.join(baseDir, repoId.kind, repoId.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "workflow.json"),
    JSON.stringify({
      id: "trigger-payload-workflow",
      triggers: [{ type: "manual" }],
      steps: {
        [stepId]: {
          kind: "step",
          id: stepId,
          agent: {
            id: "trigger-agent",
            systemPrompt: "stub",
            toolFactories: [],
            capabilities: [],
            inference: {
              sources: [{ provider: "anthropic", model: "stub-model" }],
            },
          },
          input: { from: "trigger.payload" },
          drainBehavior: "cancel",
        },
      },
      stepOrder: [stepId],
    }),
  );
}

async function seedRun(
  baseDir: string,
  workflowRunRepoId: RepoId,
  runId: string,
  events: { seq: number; type: string; [k: string]: unknown }[],
): Promise<void> {
  const dir = path.join(
    baseDir,
    workflowRunRepoId.kind,
    workflowRunRepoId.id,
    "runs",
    runId,
    "events",
  );
  await fs.mkdir(dir, { recursive: true });
  for (const event of events) {
    await fs.writeFile(
      path.join(dir, `${String(event.seq)}.json`),
      JSON.stringify(event),
    );
  }
}

/**
 * Seed a claim-check processing entry into the workflow-run repo's
 * working tree so the child's `trigger.fire` handler can recover the
 * inbound message bytes by messageId. Mirrors the production substrate's
 * working-tree materialization: the supervisor's `dequeueToProcessing`
 * commit lands the entry at
 * `addresses/<urlEncoded(address)>/processing/<receivedAt>-<messageId>.json`,
 * which `readProcessingEntry` reads with a flat fs read.
 */
async function seedProcessingEntry(
  baseDir: string,
  workflowRunRepoId: RepoId,
  opts: {
    address: string;
    messageId: string;
    receivedAt: number;
    text: string;
    from?: string;
  },
): Promise<void> {
  const dir = path.join(
    baseDir,
    workflowRunRepoId.kind,
    workflowRunRepoId.id,
    "addresses",
    encodeURIComponent(opts.address),
    "processing",
  );
  await fs.mkdir(dir, { recursive: true });
  const rawMessage = assembleConversationMessage(opts.address, opts.text, {
    from: opts.from,
  });
  const envelope = {
    messageId: opts.messageId,
    receivedAt: opts.receivedAt,
    address: opts.address,
    mailAuditRef: { store: "test", path: opts.messageId },
    rawMessage: base64Encode(rawMessage),
  };
  await fs.writeFile(
    path.join(dir, `${String(opts.receivedAt)}-${opts.messageId}.json`),
    JSON.stringify(envelope),
  );
}

/**
 * Assemble a signed conversation MIME message carrying `text`, matching
 * the on-wire shape the hub's `routeMail` path delivers. The signature
 * bytes are a placeholder: the child's input extraction reads the
 * conversation text at part `1.1` and never verifies the signature.
 */
function assembleConversationMessage(
  to: string,
  text: string,
  opts?: { from?: string | undefined },
): Uint8Array {
  const headers: MessageHeaders = {
    from: opts?.from ?? "user@example.com",
    to: [to],
    cc: undefined,
    date: new Date(0),
    messageId: "<seed@example.com>",
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

function buildBindings(opts: {
  baseDir: string;
  childKeyPair?: { privateKey: Uint8Array; publicKey: Uint8Array };
}): RunWorkflowChildBindings {
  const substrate = createStubRepoStore(opts.baseDir);
  const principal: Principal = { kind: "supervisor" };
  const childKeyPair = opts.childKeyPair;
  return {
    substrate,
    workflowRunRepoId: { kind: "workflow-run", id: "deployment-x" },
    workflowRunRef: "refs/heads/main",
    principal,
    workflowDefinitionRepoId: { kind: "workflow", id: "workflow-asset" },
    workflowDefinitionRef: "refs/heads/main",
    invokeStep: async () => ({ output: null }),
    spawnChild: async () => ({ terminalStatus: "completed" }),
    scheduler: {
      scheduleIn: () => () => undefined,
    },
    evaluateGrants: async () => ({
      effect: "allow" as const,
      matchingGrants: [],
      resolvedBy: null,
    }),
    ...(childKeyPair !== undefined
      ? { ipcChildKeyPairFactory: () => Promise.resolve(childKeyPair) }
      : {}),
    initialCredentialsSnapshot: {
      steps: [
        {
          stepId: "step-1",
          address: "deployment-x-step-1@example.com",
          grants: [],
          contentHash: "deadbeef",
        },
      ],
    },
  };
}

function makeSpawnEnv(opts: {
  channelId: string;
  hmacKeyHex: string;
  hostPubKeyHex: string;
}): Record<string, string> {
  return {
    IPC_CHANNEL_ID: opts.channelId,
    IPC_HMAC_KEY: opts.hmacKeyHex,
    HOST_PUBKEY: opts.hostPubKeyHex,
    DEPLOYMENT_ID: "deployment-x",
    DEFINITION_HASH: "definition-hash-abc",
    MAILBOX_ADDRESS: "deployment-x@example.com",
  };
}

describe("parseSpawnTimeEnv", () => {
  test("validates the required spawn-time env keys", () => {
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const keypair = {
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
    };
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(keypair.publicKey),
      }),
    );
    expect(env.channelId).toBe(channelId);
    expect(env.hmacKey).toEqual(hmacKey);
    expect(env.hostPublicKey).toEqual(keypair.publicKey);
    expect(env.deploymentId).toBe("deployment-x");
    expect(env.definitionHash).toBe("definition-hash-abc");
    expect(env.mailboxAddress).toBe("deployment-x@example.com");
    // WARM_KEEP absent -> warm-keep off (deterministic, opt-in).
    expect(env.warmKeep).toBe(false);
  });

  test("parses WARM_KEEP=true as warm-keep on, any other value as off", () => {
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const hostPubKeyHex = hexEncode(new Uint8Array(32));
    const base = makeSpawnEnv({
      channelId,
      hmacKeyHex: hexEncode(hmacKey),
      hostPubKeyHex,
    });
    expect(parseSpawnTimeEnv({ ...base, WARM_KEEP: "true" }).warmKeep).toBe(
      true,
    );
    expect(parseSpawnTimeEnv({ ...base, WARM_KEEP: "false" }).warmKeep).toBe(
      false,
    );
    // A non-"true" value is NOT a silent enable.
    expect(parseSpawnTimeEnv({ ...base, WARM_KEEP: "1" }).warmKeep).toBe(false);
  });

  test("rejects env missing a required key", () => {
    expect(() =>
      parseSpawnTimeEnv({
        IPC_CHANNEL_ID: generateChannelId(),
        IPC_HMAC_KEY: hexEncode(generateHmacKey()),
        HOST_PUBKEY: hexEncode(new Uint8Array(32)),
        DEPLOYMENT_ID: "d",
        DEFINITION_HASH: "h",
      }),
    ).toThrow(/MAILBOX_ADDRESS/);
  });

  test("rejects an off-size HMAC key", () => {
    expect(() =>
      parseSpawnTimeEnv(
        makeSpawnEnv({
          channelId: generateChannelId(),
          hmacKeyHex: "deadbeef",
          hostPubKeyHex: hexEncode(new Uint8Array(32)),
        }),
      ),
    ).toThrow(/HMAC_KEY|decode to/);
  });

  test("rejects an off-size HOST_PUBKEY", () => {
    expect(() =>
      parseSpawnTimeEnv(
        makeSpawnEnv({
          channelId: generateChannelId(),
          hmacKeyHex: hexEncode(generateHmacKey()),
          hostPubKeyHex: "deadbeef",
        }),
      ),
    ).toThrow(/HOST_PUBKEY|decode to/);
  });

  test("rejects an off-size channelId", () => {
    expect(() =>
      parseSpawnTimeEnv(
        makeSpawnEnv({
          channelId: "short",
          hmacKeyHex: hexEncode(generateHmacKey()),
          hostPubKeyHex: hexEncode(new Uint8Array(32)),
        }),
      ),
    ).toThrow(/IPC_CHANNEL_ID/);
  });
});

describe("runWorkflowChild", () => {
  test("emits ready, processes a trigger.fire frame, and shuts down", async () => {
    const baseDir = await makeTempDir("child-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });
    // Seed the claim-check processing entry the child reads to recover
    // the inbound message bytes for the `trigger.fire` below. The
    // supervisor's dispatch loop creates this entry via
    // `dequeueToProcessing` before forwarding the trigger.
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-1",
        receivedAt: 1,
        text: "hello from the inbox",
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    const bindings = buildBindings({
      baseDir,
      childKeyPair,
    });

    // Drive the supervisor side: sign trigger.fire then shutdown.
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

    // Wait briefly for the child to emit `ready`. The upstream
    // sender's seq starts at 1 so the supervisor's receiver iterator
    // can decode it without rejecting a seq gap.
    let readyLine: string | undefined;
    for (let i = 0; i < 200 && readyLine === undefined; i += 1) {
      const flushed = childToSupervisor.flushed();
      if (flushed.length > 0) readyLine = flushed[0];
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(readyLine).toBeDefined();

    await supervisorSender.send({
      type: "trigger.fire",
      data: {
        runId: "run-1",
        messageId: "msg-1",
        receivedAt: 1,
      },
    });
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-1"]);
    expect(result.finalCredentialsSnapshot).not.toBeNull();
    expect(result.finalCredentialsSnapshot?.steps).toHaveLength(1);
  });

  test("cold path fires cleanupRunStorage once per run at run granularity, never before terminal", async () => {
    const baseDir = await makeTempDir("child-cold-cleanup-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });
    for (const messageId of ["msg-1", "msg-2"]) {
      await seedProcessingEntry(
        baseDir,
        { kind: "workflow-run", id: "deployment-x" },
        {
          address: "deployment-x@example.com",
          messageId,
          receivedAt: 1,
          text: `body ${messageId}`,
        },
      );
    }

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    // Record every runId the run-loop asks to reclaim, in order. A run's
    // entry must appear only after that run reaches its terminal status,
    // and exactly once -- proving run (not step) granularity and that no
    // in-flight run's subtree is touched.
    const cleaned: string[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      cleanupRunStorage: (runId: string) => {
        cleaned.push(runId);
        return Promise.resolve();
      },
    };

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

    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);

    // Two independent runs. The stub `invokeStep` returns immediately, so
    // each run reaches terminal on its own; the run-loop fires cleanup per
    // run with that run's id.
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-1", messageId: "msg-1", receivedAt: 1 },
    });
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-2", messageId: "msg-2", receivedAt: 2 },
    });
    // Both runs reach terminal asynchronously; the run-loop fires cleanup
    // in each run's completion continuation. Wait for both reclamations
    // before tearing the loop down so the assertion observes the per-run
    // firing rather than racing the shutdown.
    for (let i = 0; i < 400 && cleaned.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-1", "run-2"]);
    // Exactly one reclamation per run, keyed by that run's id -- never a
    // per-step or per-attempt call, never another run's id.
    expect([...cleaned].sort()).toEqual(["run-1", "run-2"]);
  });

  test("warm path never fires cleanupRunStorage on run completion", async () => {
    const baseDir = await makeTempDir("child-warm-no-cleanup-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-1",
        receivedAt: 1,
        text: "warm body",
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    // WARM_KEEP="true": the warm single-step deployment reuses one stable
    // workspace across runs, so deleting per run would wipe a live
    // conversation's files. The run-loop's warmKeep gate must suppress the
    // per-run cleanup entirely even when a callback is wired.
    const env = parseSpawnTimeEnv({
      ...makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
      WARM_KEEP: "true",
    });
    expect(env.warmKeep).toBe(true);

    const cleaned: string[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      cleanupRunStorage: (runId: string) => {
        cleaned.push(runId);
        return Promise.resolve();
      },
    };

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

    // Decode the child's upstream frames so the test can observe the run
    // reach TERMINAL. The warm gate lives in the same void-ed
    // `handle.complete.then(...)` continuation that emits the
    // `terminal.event`, and that continuation runs the gate BEFORE the
    // emit. Waiting for `terminal.event` therefore proves the continuation
    // executed -- so a subsequent `cleaned` assertion fires at exactly the
    // point the cold path WOULD have deleted, making the suppression proof
    // non-vacuous rather than passing merely because the continuation never
    // ran. The receiver bootstraps the child's verifying key from `ready`;
    // `flushed()`-based waits elsewhere are non-consuming, so `ready` is
    // still queued for this iterator.
    const recvIter = receiveControlChannel({
      publicKey: { bootstrapFromReady: true },
      channelId,
      reader: childToSupervisor.reader,
      onCrash: (reason) => {
        throw new Error(`unexpected control channel crash: ${reason}`);
      },
    });

    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-1", messageId: "msg-1", receivedAt: 1 },
    });

    let sawTerminal = false;
    for await (const payload of recvIter) {
      if (payload.type === "terminal.event" && payload.data.runId === "run-1") {
        sawTerminal = true;
        break;
      }
    }
    expect(sawTerminal).toBe(true);
    // The run reached terminal AND the completion continuation ran (it
    // emitted the terminal.event we just observed). On the cold path the
    // same continuation would have called cleanupRunStorage by now; the
    // warm gate suppressed it. Asserting here -- before shutdown -- proves
    // the suppression, not a race.
    expect(cleaned).toEqual([]);

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-1"]);
    expect(cleaned).toEqual([]);
  });

  test("self-discovery resumes non-terminal runs and skips terminal ones", async () => {
    const baseDir = await makeTempDir("child-discover-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });
    // Run "live" has RunStarted but no terminal event.
    await seedRun(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      "run-live",
      [
        {
          seq: 1,
          type: "RunStarted",
          at: "2026-01-01T00:00:00.000Z",
          runId: "run-live",
          definitionHash: "definition-hash-abc",
          trigger: { type: "manual", payload: null },
        },
      ],
    );
    // Run "done" has a RunCompleted terminal event.
    await seedRun(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      "run-done",
      [
        {
          seq: 1,
          type: "RunStarted",
          at: "2026-01-01T00:00:00.000Z",
          runId: "run-done",
          definitionHash: "definition-hash-abc",
          trigger: { type: "manual", payload: null },
        },
        {
          seq: 2,
          type: "RunCompleted",
          at: "2026-01-01T00:00:01.000Z",
        },
      ],
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    const bindings = buildBindings({
      baseDir,
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

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.resumedRunIds).toEqual(["run-live"]);
    expect(result.resumedRunIds).not.toContain("run-done");
  });

  // WORKBENCH-LOCAL (CL-2535): the recoverParkedRun seam end-to-end. A run
  // discovered parked at an awaitSignal gate is offered to the hook, which
  // host-satisfies it; the loop resumes the satisfied seed (instead of failing
  // an unresumable tail). Proves detection (hasUnresumableTail), invocation with
  // the run's blob substrate, and that the returned seed drives the resume.
  test("recoverParkedRun resumes a run parked at an awaitSignal gate", async () => {
    const baseDir = await makeTempDir("child-recover-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();

    const assetDir = path.join(baseDir, "workflow", "workflow-asset");
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(
      path.join(assetDir, "workflow.json"),
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

    // A run parked at the gate (awaiting-signal tail) — the durable shape a
    // sidecar restart leaves behind.
    await seedRun(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      "run-parked",
      [
        {
          seq: 1,
          type: "RunStarted",
          at: "2026-01-01T00:00:00.000Z",
          runId: "run-parked",
          definitionHash: "h",
          trigger: { type: "manual", payload: null },
        },
        {
          seq: 2,
          type: "StepStarted",
          at: "2026-01-01T00:00:00.100Z",
          stepId: "gate",
          attempt: 1,
          input: { ref: "inline:null" },
        },
        {
          seq: 3,
          type: "SignalAwaited",
          at: "2026-01-01T00:00:00.200Z",
          stepId: "gate",
          signalName: "go",
        },
      ],
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildBindings({ baseDir, childKeyPair });
    const supervisorSender = createControlChannelSender({
      privateKeySeed: supervisorKeyPair.privateKey,
      channelId,
      writer: supervisorToChild.writer,
    });

    const recoverCalls: { runId: string; hasBlobs: boolean }[] = [];
    const runPromise = runWorkflowChild({
      env,
      controlReader: supervisorToChild.reader,
      controlWriter: childToSupervisor.writer,
      eventWriter: eventStream.writer,
      bindings,
      recoverParkedRun: async (run, ctx) => {
        recoverCalls.push({
          runId: run.runId,
          hasBlobs: ctx.blobs !== undefined,
        });
        const maxSeq = run.seedEvents.reduce((m, e) => Math.max(m, e.seq), 0);
        const at = "2026-01-01T00:00:01.000Z";
        const { ref } = await ctx.blobs.recordOutput("gate", 1, {
          approved: true,
        });
        const satisfied: WorkflowEvent[] = [
          ...run.seedEvents,
          {
            kind: "SignalReceived",
            seq: maxSeq + 1,
            at,
            signalName: "go",
            signalId: "sig-1",
            payload: { approved: true },
          },
          {
            kind: "StepCompleted",
            seq: maxSeq + 2,
            at,
            stepId: "gate",
            attempt: 1,
            output: { ref },
          },
        ];
        return satisfied;
      },
    });

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;

    expect(recoverCalls).toEqual([{ runId: "run-parked", hasBlobs: true }]);
    expect(result.resumedRunIds).toContain("run-parked");
  });

  // WORKBENCH-LOCAL (CL-2535): a recoverParkedRun hook that THROWS must NOT
  // crash the child. This runs during self-discovery before `ready`; an
  // uncaught throw would reject runWorkflowChild, trip the binary's
  // unhandledRejection -> exit(1), and wedge the whole deployment. The guard
  // makes one bad run fall through to the default path instead.
  test("a throwing recoverParkedRun hook does not crash the child (falls through)", async () => {
    const baseDir = await makeTempDir("child-recover-throw-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();

    const assetDir = path.join(baseDir, "workflow", "workflow-asset");
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(
      path.join(assetDir, "workflow.json"),
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
    await seedRun(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      "run-parked",
      [
        {
          seq: 1,
          type: "RunStarted",
          at: "2026-01-01T00:00:00.000Z",
          runId: "run-parked",
          definitionHash: "h",
          trigger: { type: "manual", payload: null },
        },
        {
          seq: 2,
          type: "StepStarted",
          at: "2026-01-01T00:00:00.100Z",
          stepId: "gate",
          attempt: 1,
          input: { ref: "inline:null" },
        },
        {
          seq: 3,
          type: "SignalAwaited",
          at: "2026-01-01T00:00:00.200Z",
          stepId: "gate",
          signalName: "go",
        },
      ],
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildBindings({ baseDir, childKeyPair });
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
      recoverParkedRun: async () => {
        throw new Error("boom recovery");
      },
    });

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    // Must RESOLVE (reach `ready`) despite the hook throwing — not reject.
    const result = await runPromise;
    expect(result.resumedRunIds).toContain("run-parked");
  });

  test("grants-updated frame replaces the active credentialsSnapshot", async () => {
    const baseDir = await makeTempDir("child-grants-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    const bindings = buildBindings({
      baseDir,
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

    const refreshedSnapshot = {
      steps: [
        {
          stepId: "step-1",
          address: "deployment-x-step-1@example.com",
          grants: [{ resource: "thing", action: "read" }],
          contentHash: "freshhash",
        },
      ],
    };
    await supervisorSender.send({
      type: "grants-updated",
      data: {
        snapshot: refreshedSnapshot,
        stepHashes: { "step-1": "freshhash" },
      },
    });
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.finalCredentialsSnapshot).not.toBeNull();
    expect(result.finalCredentialsSnapshot?.steps[0]?.contentHash).toBe(
      "freshhash",
    );
    expect(result.finalCredentialsSnapshot?.steps[0]?.grants).toEqual([
      { resource: "thing", action: "read" },
    ]);
  });

  test("child ready frame is signed by the child's own keypair and bootstraps the supervisor's verification key", async () => {
    const baseDir = await makeTempDir("child-ready-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    const bindings = buildBindings({
      baseDir,
      childKeyPair,
    });

    // Run the child, capture its ready frame, verify via the
    // receiver iterator's bootstrap mode. The receiver extracts the
    // child's public key from the first frame's payload -- the
    // supervisor's private key never enters this code path.
    const runPromise = runWorkflowChild({
      env,
      controlReader: supervisorToChild.reader,
      controlWriter: childToSupervisor.writer,
      eventWriter: eventStream.writer,
      bindings,
    });
    const crashes: string[] = [];
    const recvIter = receiveControlChannel({
      publicKey: { bootstrapFromReady: true },
      channelId,
      reader: childToSupervisor.reader,
      onCrash: (reason) => crashes.push(reason),
    });
    let readyPayload: { type: string; childPublicKey?: string } | undefined;
    for await (const payload of recvIter) {
      if (payload.type !== "ready") continue;
      readyPayload = {
        type: payload.type,
        childPublicKey: payload.data.childPublicKey,
      };
      break;
    }
    expect(readyPayload?.type).toBe("ready");
    expect(readyPayload?.childPublicKey).toBe(
      hexEncode(childKeyPair.publicKey),
    );
    expect(crashes).toHaveLength(0);

    // Tear down.
    const supervisorSender = createControlChannelSender({
      privateKeySeed: supervisorKeyPair.privateKey,
      channelId,
      writer: supervisorToChild.writer,
    });
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    childToSupervisor.close();
    await runPromise;
  });

  test("hub-originated JSON trigger body becomes trigger.payload object for step input", async () => {
    const baseDir = await makeTempDir("child-hub-structured-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    const structured = {
      contentName: "post",
      channel: "x",
      topic: "neobank launches",
    };
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-hub",
        receivedAt: 1,
        from: "hub@example.com",
        text: JSON.stringify(structured),
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const stepInputs: unknown[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      invokeStep: async (req) => {
        stepInputs.push(req.input);
        return { output: null };
      },
    };
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-hub", messageId: "msg-hub", receivedAt: 1 },
    });
    for (let i = 0; i < 400 && stepInputs.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-hub"]);
    expect(stepInputs[0]).toEqual(structured);
  });

  test("user-originated mail that looks like JSON stays plain text trigger payload", async () => {
    const baseDir = await makeTempDir("child-user-json-text-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    const jsonText = '{"looks":"like json"}';
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-user",
        receivedAt: 1,
        text: jsonText,
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const stepInputs: unknown[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      invokeStep: async (req) => {
        stepInputs.push(req.input);
        return { output: null };
      },
    };
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-user", messageId: "msg-user", receivedAt: 1 },
    });
    for (let i = 0; i < 400 && stepInputs.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-user"]);
    expect(stepInputs[0]).toBe(jsonText);
  });

  test("hub-originated non-JSON trigger body fails closed", async () => {
    const baseDir = await makeTempDir("child-hub-bad-json-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-bad",
        receivedAt: 1,
        from: "hub@example.com",
        text: "not-json",
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildBindings({ baseDir, childKeyPair });
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-bad", messageId: "msg-bad", receivedAt: 1 },
    });
    supervisorToChild.close();
    await expect(runPromise).rejects.toThrow(/not valid JSON/);
  });

  test("hub sender with a display-name from-header decodes to a trigger.payload object", async () => {
    const baseDir = await makeTempDir("child-hub-displayname-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    const structured = { contentName: "post", channel: "x" };
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-hub-dn",
        receivedAt: 1,
        from: "Workbench Hub <hub@example.com>",
        text: JSON.stringify(structured),
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const stepInputs: unknown[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      invokeStep: async (req) => {
        stepInputs.push(req.input);
        return { output: null };
      },
    };
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-hub-dn", messageId: "msg-hub-dn", receivedAt: 1 },
    });
    for (let i = 0; i < 400 && stepInputs.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-hub-dn"]);
    expect(stepInputs[0]).toEqual(structured);
  });

  test("hub local-part from a foreign domain stays plain text trigger payload", async () => {
    const baseDir = await makeTempDir("child-hub-foreign-domain-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    const jsonText = '{"spoofed":"payload"}';
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-foreign",
        receivedAt: 1,
        from: "hub@attacker.example",
        text: jsonText,
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const stepInputs: unknown[] = [];
    const bindings: RunWorkflowChildBindings = {
      ...buildBindings({ baseDir, childKeyPair }),
      invokeStep: async (req) => {
        stepInputs.push(req.input);
        return { output: null };
      },
    };
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-foreign", messageId: "msg-foreign", receivedAt: 1 },
    });
    for (let i = 0; i < 400 && stepInputs.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual(["run-foreign"]);
    expect(stepInputs[0]).toBe(jsonText);
  });

  test("hub-originated JSON array body fails closed", async () => {
    const baseDir = await makeTempDir("child-hub-array-trigger-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedTriggerPayloadWorkflow(baseDir, "step-1");
    await seedProcessingEntry(
      baseDir,
      { kind: "workflow-run", id: "deployment-x" },
      {
        address: "deployment-x@example.com",
        messageId: "msg-array",
        receivedAt: 1,
        from: "hub@example.com",
        text: JSON.stringify([1, 2, 3]),
      },
    );

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildBindings({ baseDir, childKeyPair });
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
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-array", messageId: "msg-array", receivedAt: 1 },
    });
    supervisorToChild.close();
    await expect(runPromise).rejects.toThrow(/must be a JSON object/);
  });

  test("rejects a control frame whose signature does not verify", async () => {
    const baseDir = await makeTempDir("child-bad-sig-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const otherKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    await seedWorkflowDefinition(baseDir, {
      kind: "workflow",
      id: "workflow-asset",
    });

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );

    const bindings = buildBindings({
      baseDir,
      childKeyPair,
    });

    // Sign with the WRONG key -- the receiver iterator's signature
    // check should reject the frame and the loop should end without
    // recording a triggered run.
    const wrongSender = createControlChannelSender({
      privateKeySeed: otherKeyPair.privateKey,
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

    await wrongSender.send({
      type: "trigger.fire",
      data: {
        runId: "run-bad",
        messageId: "msg-bad",
        receivedAt: 1,
      },
    });
    supervisorToChild.close();

    const result = await runPromise;
    expect(result.triggeredRunIds).toEqual([]);
  });
});

describe("runWorkflowChildFromProcessEnv", () => {
  test("missing spawn-time env throws via parseSpawnTimeEnv", async () => {
    const { runWorkflowChildFromProcessEnv } = await import("./index");
    await expect(
      runWorkflowChildFromProcessEnv(
        async () => {
          throw new Error(
            "factory must not be invoked when env validation fails",
          );
        },
        { rawEnv: {} },
      ),
    ).rejects.toThrow(/spawn-time env failed validation/);
  });

  test("missing substrate-config key throws before the factory runs", async () => {
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const hostKeypair = await generateKeyPair();
    const env = makeSpawnEnv({
      channelId,
      hmacKeyHex: hexEncode(hmacKey),
      hostPubKeyHex: hexEncode(hostKeypair.publicKey),
    });
    const { runWorkflowChildFromProcessEnv } = await import("./index");
    await expect(
      runWorkflowChildFromProcessEnv(
        async () => {
          throw new Error("factory must not be invoked when key is missing");
        },
        {
          rawEnv: env,
          substrateConfigKeys: ["MISSING_KEY"],
        },
      ),
    ).rejects.toThrow(/MISSING_KEY is unset/);
  });
});

const STUB_SOURCE: InferenceSource = {
  id: "anthropic:stub",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-stub",
  model: "stub-model",
};

function stubStepEnv(): StepEnvBase {
  return {
    sources: [STUB_SOURCE],
    defaultSource: STUB_SOURCE.id,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; the spy agentFactory never reads the env
    storage: {} as ContextStore,
    workdir: "/tmp/warm-agent-roundtrip-stub",
    audit: noopAuditStore(),
    directors: createDefaultDirectorRegistry(),
  };
}

interface WarmAgentSpy {
  lspSpawnCount: number;
  lspAlive: boolean;
  closeCount: number;
  readonly conversation: string[];
  readonly replies: string[];
}

/**
 * Spy agent that models the warm-keep lifecycle guards for the
 * round-trip integration test: an LSP-subprocess analogue spawned once
 * at construction and disposed on `close()`, an in-memory conversation
 * retained across sends, and a `stream()` that ends only at `close()`.
 * The reply echoes the running conversation so the second reply
 * reflects the first message (continuity).
 */
function buildWarmAgentSpy(): { agent: Agent; spy: WarmAgentSpy } {
  const spy: WarmAgentSpy = {
    lspSpawnCount: 1,
    lspAlive: true,
    closeCount: 0,
    conversation: [],
    replies: [],
  };
  let endStream: () => void = () => undefined;
  const streamEnded = new Promise<void>((resolve) => {
    endStream = resolve;
  });
  const agent: Agent = {
    async send(content): Promise<SendResult> {
      if (!spy.lspAlive) {
        throw new Error("warm spy: send after LSP disposed");
      }
      const text = typeof content === "string" ? content : "message";
      // The child frames the inbound mail as the conversation text; the
      // seeded body is the substring we assert on. Record just the
      // running transcript so continuity is observable.
      spy.conversation.push(text);
      const reply = `r${String(spy.conversation.length)}:${spy.conversation.join("|")}`;
      spy.replies.push(reply);
      return {
        reply,
        turn: {
          role: "assistant",
          content: [{ type: "text", text: reply }],
          model: STUB_SOURCE.model,
          timestamp: 0,
        },
      };
    },
    async *stream() {
      yield stubReactorEvent("inference.start");
      await streamEnded;
    },
    deliver(_message: InboundMessage) {
      throw new Error("stub deliver() not used");
    },
    async close() {
      spy.closeCount += 1;
      spy.lspAlive = false;
      endStream();
    },
    setSource(_source: InferenceSource) {
      throw new Error("stub setSource() not used");
    },
    setSources(_sources: InferenceSource[], _defaultSource: string) {
      throw new Error("stub setSources() not used");
    },
    async history() {
      return [];
    },
    async checkpoints() {
      return [];
    },
    async readAt() {
      return [];
    },
    blobReader: stubWarmBlobReader(),
  };
  return { agent, spy };
}

function stubWarmBlobReader(): BlobReader {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; never read on the warm path
  return {} as BlobReader;
}

// The warm agent's `stream()` yields the reactor's emitted-event type;
// the step-invoker forwarder reads only `.type` off each item. A bare
// shape is enough -- the cast localizes the structural mismatch to the
// test stub rather than widening the production type.
type StreamEvent = Agent["stream"] extends () => AsyncIterable<infer E>
  ? E
  : never;

function stubReactorEvent(type: string): StreamEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub event; only `type` is read by the forwarder
  return { type, seq: 1, data: {} } as unknown as StreamEvent;
}

/**
 * Seed a one-step workflow whose sole step's input defaults to the
 * trigger payload, so the child's `trigger.fire` delivers the inbound
 * mail body to `agent.send`. The step's `agent` envelope is a bare
 * metadata object: the runtime body passes it through to the invoker,
 * and the spy agentFactory ignores it. Written as a flat file into the
 * workflow-asset repo's working tree, which the child's
 * `loadWorkflowDefinition` reads with a flat `fs.readFile`.
 */
async function seedOneStepWorkflowDir(
  repoDir: string,
  stepId: string,
): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "workflow.json"),
    JSON.stringify({
      id: "warm-roundtrip-workflow",
      triggers: [{ type: "manual" }],
      steps: {
        [stepId]: {
          kind: "step",
          id: stepId,
          agent: {
            id: "warm-agent",
            systemPrompt: "warm agent",
            toolFactories: [],
            capabilities: [],
            inference: {
              sources: [{ provider: "anthropic", model: "stub-model" }],
            },
          },
          input: { from: "trigger.payload" },
          drainBehavior: "cancel",
        },
      },
      stepOrder: [stepId],
    }),
  );
}

/**
 * Seed a claim-check processing entry into a resolved repo directory
 * (the child reads it with a flat fs read via `readProcessingEntry`).
 * Mirrors `seedProcessingEntry` but takes the already-resolved repo dir
 * so it can target a real substrate's `getRepoDir(repoId)`.
 */
async function seedProcessingEntryInDir(
  repoDir: string,
  opts: {
    address: string;
    messageId: string;
    receivedAt: number;
    text: string;
  },
): Promise<void> {
  const dir = path.join(
    repoDir,
    "addresses",
    encodeURIComponent(opts.address),
    "processing",
  );
  await fs.mkdir(dir, { recursive: true });
  const rawMessage = assembleConversationMessage(opts.address, opts.text);
  const envelope = {
    messageId: opts.messageId,
    receivedAt: opts.receivedAt,
    address: opts.address,
    mailAuditRef: { store: "test", path: opts.messageId },
    rawMessage: base64Encode(rawMessage),
  };
  await fs.writeFile(
    path.join(dir, `${String(opts.receivedAt)}-${opts.messageId}.json`),
    JSON.stringify(envelope),
  );
}

async function waitForTriggeredRun(
  childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>,
  predicate: (lines: readonly string[]) => boolean,
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate(childToSupervisor.flushed())) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the child's upstream frames");
}

describe("warm-agent round-trip (Phase 4.4)", () => {
  test("two sequential messages reuse one warm agent, spawn the LSP once, hold continuity, and evict on shutdown", async () => {
    const baseDir = await makeTempDir("warm-roundtrip-");
    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const stepId = "step-1";
    const deploymentId = "deployment-x";
    const workflowRunRepoId: RepoId = {
      kind: "workflow-run",
      id: deploymentId,
    };
    const workflowDefinitionRepoId: RepoId = {
      kind: "workflow-run",
      id: "workflow-asset",
    };

    // Real substrate so the runtime body's event commits persist and
    // read back (the runtime stalls against a non-persisting stub). The
    // workflow-run kind handler is the same one the production substrate
    // registers; the allow-all authorize matches the substrate test
    // pattern. A `workflow-process` principal scoped to the deployment is
    // what the kind handler accepts as the runtime body's writer.
    const signingKey: KeyPair = await generateKeyPair();
    const allowAll: AuthorizeFn = () => ({ allowed: true });
    const substrate = createRepoStore({
      dataDir: baseDir,
      signingKey,
      handlers: { "workflow-run": workflowRunKindHandler },
      authorize: allowAll,
    });
    // The workflow-run kind handler accepts a `workflow-process`
    // principal scoped to the deployment as the runtime body's writer;
    // the deploymentId satisfies `enforceWorkflowProcessPathScope`.
    const principalShape = { kind: "workflow-process", deploymentId };
    const principal: Principal = principalShape;

    // Genesis the workflow-run repo so the runtime's first append has a
    // coherent prior tree, then seed the two inbound messages' claim-check
    // processing entries the child reads at each `trigger.fire`.
    await substrate.writeTree(
      { kind: "hub" },
      workflowRunRepoId,
      "refs/heads/main",
      {
        files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
        message: "genesis",
      },
    );
    const runRepoDir = substrate.getRepoDir(workflowRunRepoId);
    await seedProcessingEntryInDir(runRepoDir, {
      address: "deployment-x@example.com",
      messageId: "msg-1",
      receivedAt: 1,
      text: "alpha body",
    });
    await seedProcessingEntryInDir(runRepoDir, {
      address: "deployment-x@example.com",
      messageId: "msg-2",
      receivedAt: 2,
      text: "bravo body",
    });

    // The workflow definition the child loads. Genesis the asset repo so
    // its working tree exists, then write `workflow.json` the child reads
    // flat.
    await substrate.writeTree(
      { kind: "hub" },
      workflowDefinitionRepoId,
      "refs/heads/main",
      {
        files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
        message: "genesis",
      },
    );
    await seedOneStepWorkflowDir(
      substrate.getRepoDir(workflowDefinitionRepoId),
      stepId,
    );

    const { agent, spy } = buildWarmAgentSpy();
    let factoryCalls = 0;

    // The real run-loop wiring: the child's `invokeStep` binding builds
    // a fresh `createWorkflowStepInvoker` per invocation and forwards the
    // run-loop's warm cache to it. This mirrors the sidecar's production
    // binding (`workflow-substrate-factory.ts`) minus the tool-bearing
    // factory -- here the agentFactory is a spy that counts builds.
    const invokeStep: ChildStepInvoker = async (
      req,
      onEvent,
      authorize,
      warmCache,
    ) =>
      createWorkflowStepInvoker({
        workflowAuthorize: authorize,
        buildEnv: async () => stubStepEnv(),
        agentFactory: async () => {
          factoryCalls += 1;
          return agent;
        },
        onEvent: (event) => onEvent(event),
        ...(warmCache !== undefined ? { warmCache } : {}),
      })(req);

    const bindings: RunWorkflowChildBindings = {
      substrate,
      workflowRunRepoId,
      workflowRunRef: "refs/heads/main",
      principal,
      workflowDefinitionRepoId,
      workflowDefinitionRef: "refs/heads/main",
      invokeStep,
      spawnChild: async () => ({ terminalStatus: "completed" }),
      scheduler: { scheduleIn: () => () => undefined },
      evaluateGrants: async () => ({
        effect: "allow" as const,
        matchingGrants: [],
        resolvedBy: null,
      }),
      ipcChildKeyPairFactory: () => Promise.resolve(childKeyPair),
      initialCredentialsSnapshot: {
        steps: [
          {
            stepId,
            address: "deployment-x@example.com",
            grants: [],
            contentHash: "deadbeef",
          },
        ],
      },
    };

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();

    // WARM_KEEP="true": the single-step long-lived deployment the deploy
    // projection marks a warm candidate. The run-loop builds a warm
    // cache and the step-invoker reuses the agent across messages.
    const env = parseSpawnTimeEnv({
      ...makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
      WARM_KEEP: "true",
    });
    expect(env.warmKeep).toBe(true);

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

    // Wait for ready.
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);

    // First message.
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-1", messageId: "msg-1", receivedAt: 1 },
    });
    await waitForTriggeredRun(childToSupervisor, () => spy.replies.length >= 1);

    // After one message the agent was built exactly once, the LSP is
    // alive (no teardown between messages), and nothing was closed.
    expect(factoryCalls).toBe(1);
    expect(spy.lspAlive).toBe(true);
    expect(spy.closeCount).toBe(0);

    // Second message.
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-2", messageId: "msg-2", receivedAt: 2 },
    });
    await waitForTriggeredRun(childToSupervisor, () => spy.replies.length >= 2);

    // STILL one build -- the warm agent was reused, not rebuilt -- and
    // the LSP subprocess was spawned once and never torn down between
    // the two messages. This is exactly what fails against per-message
    // teardown: there, factoryCalls would be 2 and the LSP would respawn.
    expect(factoryCalls).toBe(1);
    expect(spy.lspSpawnCount).toBe(1);
    expect(spy.lspAlive).toBe(true);
    expect(spy.closeCount).toBe(0);

    // Conversation continuity: the warm agent retained the first
    // message in memory, so the second reply reflects BOTH bodies.
    expect(spy.replies[0]).toContain("alpha body");
    expect(spy.replies[1]).toContain("alpha body");
    expect(spy.replies[1]).toContain("bravo body");

    // Undeploy -> shutdown. Eviction runs the wrapped close exactly once
    // and the LSP subprocess dies.
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "undeploy" },
    });
    supervisorToChild.close();
    const result = await runPromise;

    expect(result.triggeredRunIds).toEqual(["run-1", "run-2"]);
    expect(spy.closeCount).toBe(1);
    expect(spy.lspAlive).toBe(false);
  });
});

describe("event channel writer wiring", () => {
  test("the event sender encodes and authenticates frames sent through it", async () => {
    // Sanity check: a frame the child's event sender would emit is
    // round-trippable through the receiver iterator. This is a
    // synthetic exercise but pinning it here guarantees the writer
    // shape `runWorkflowChild` accepts matches the IPC primitives.
    const hmacKey = generateHmacKey();
    const channelId = generateChannelId();
    const stream = createMemoryFrameStream();
    const { createEventChannelSender } = await import("../ipc/index");
    const sender = createEventChannelSender({
      hmacKey,
      channelId,
      writer: stream.writer,
    });
    await sender.send({
      type: "message.run.started",
      seq: 1,
      data: {
        messageId: "m",
        messageRunId: "r",
        receivedAt: 1,
      },
    });
    stream.close();
    const crashes: string[] = [];
    const recv = receiveEventChannel({
      hmacKey,
      channelId,
      reader: stream.reader,
      onCrash: (reason) => crashes.push(reason),
    });
    let firstType: string | undefined;
    for await (const payload of recv) {
      firstType = payload.type;
      break;
    }
    expect(firstType).toBe("message.run.started");
    expect(crashes).toHaveLength(0);
  });
});

// WORKBENCH-LOCAL (CL-2537): the live awaitSignal watcher. A run discovered
// parked at an `awaitSignal` gate STILL waiting for a human no longer dies on a
// sidecar restart: instead of `runtimeRun` rejecting the unresumable tail, the
// child installs a live watcher that keeps the run parked, subscribes to the
// gate's signal source, and on signal arrival host-satisfies + resumes — which
// both saves the run AND lets it reach terminal so the supervisor's dispatch
// loop unwedges. These tests use the REAL workflow-run substrate (persisting
// writes + a live `subscribeKind` tail) so the watcher's subscribe → recheck →
// recover → resume seam is exercised end-to-end, not against a stub.
describe("CL-2537 live awaitSignal watcher", () => {
  const GATE_DEPLOYMENT_ID = "deployment-gate";
  const PARKED_AT = "2026-01-01T00:00:00.000Z";

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
    // Build the shape first, then widen to `Principal`: a direct annotated
    // literal trips excess-property checking on the union (mirrors the
    // warm-agent round-trip harness above).
    const principalShape = {
      kind: "workflow-process",
      deploymentId: GATE_DEPLOYMENT_ID,
    };
    const principal: Principal = principalShape;
    await substrate.writeTree(
      { kind: "hub" },
      workflowRunRepoId,
      "refs/heads/main",
      { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" }, message: "genesis" },
    );
    await substrate.writeTree(
      { kind: "hub" },
      workflowDefinitionRepoId,
      "refs/heads/main",
      { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" }, message: "genesis" },
    );
    await seedGateWorkflowDir(substrate.getRepoDir(workflowDefinitionRepoId));
    return {
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
    };
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
            address: "deployment-gate@example.com",
            grants: [],
            contentHash: "deadbeef",
          },
        ],
      },
    };
  }

  // Commit a run parked at the gate (RunStarted, StepStarted, SignalAwaited)
  // through the SAME adapter the runtime body writes with, so both the
  // working-tree `read` path and the committed `subscribeKind` tail see it —
  // exactly the durable shape a sidecar restart leaves behind.
  async function commitParkedRun(
    substrate: RepoStore,
    principal: Principal,
    workflowRunRepoId: RepoId,
    runId: string,
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the state-machine WorkflowEvent union is narrowed downstream by the runtime; these literals match the runtime's own append shape
    ] as unknown as WorkflowEvent[]);
  }

  // Faithful in-test stand-in for apps/sidecar's `recoverParkedRunFromLog` (the
  // production hook wired into the child). packages/workflow-host cannot import
  // from apps/sidecar (backwards dependency), so the gate-completion logic is
  // replicated here: given a log carrying a delivered `SignalReceived` for an
  // awaited gate that has no `StepCompleted`, append the missing `StepCompleted`
  // (output re-materialized through the run's blob substrate) and return the
  // satisfied seed; otherwise `null`. `recoverParkedRunFromLog`'s own
  // correctness is covered by apps/sidecar/src/workflow-resume.test.ts.
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
      // The raw working-tree read can momentarily ENOENT while the substrate
      // checks out a concurrent commit; the poller just retries on the next
      // tick (the same benign race the watcher's read tolerates in production).
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

  function countKind(log: readonly WorkflowEvent[], kind: string): number {
    return log.filter((e) => e.kind === kind).length;
  }

  function deliverGoSignal(
    sender: ReturnType<typeof createControlChannelSender>,
    runId: string,
    signalId: string,
  ): Promise<void> {
    return sender.send({
      type: "signal.deliver",
      data: {
        runId,
        signalName: "go",
        signalId,
        payload: { approved: true },
      },
    });
  }

  // Wrap a substrate so live `subscribe` iterators are counted: +1 when the
  // generator starts, -1 when it settles (return/throw/abort). A leaked
  // subscribeKind tail would never settle, so a non-zero count after teardown is
  // a real leak the test catches.
  function trackSubscriptions(substrate: RepoStore): {
    substrate: RepoStore;
    live: () => number;
  } {
    let live = 0;
    const origSubscribe = substrate.subscribe.bind(substrate);
    const wrapped = new Proxy(substrate, {
      get(target, prop, receiver) {
        if (prop === "subscribe") {
          return ((...args: Parameters<RepoStore["subscribe"]>) => {
            const inner = origSubscribe(...args);
            live += 1;
            return (async function* () {
              try {
                for await (const entry of inner) yield entry;
              } finally {
                live -= 1;
              }
            })();
          }) as RepoStore["subscribe"];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { substrate: wrapped, live: () => live };
  }

  test("watcher resumes a parked run to RunCompleted when the human signal lands after restart", async () => {
    const baseDir = await makeTempDir("watcher-resume-");
    const {
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
    } = await genesisGateDeployment(baseDir);
    await commitParkedRun(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
    );

    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
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

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
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
      recoverParkedRun: makeGateRecoverHook(),
    });

    // The parked run is watched, not resumed at startup: it must NOT appear on
    // the startup resume list and must still be parked (no RunCompleted yet).
    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    const beforeSignal = await readRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
    );
    expect(countKind(beforeSignal, "RunCompleted")).toBe(0);

    // The human approves: the supervisor delivers the gate signal. The watcher's
    // live tail observes the commit and resumes the run to completion.
    await deliverGoSignal(supervisorSender, "run-parked", "sig-1");
    const afterSignal = await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "watcher resume -> RunCompleted",
    );
    expect(countKind(afterSignal, "RunCompleted")).toBe(1);

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;
    // The watcher path never pushes to the startup resume list.
    expect(result.resumedRunIds).not.toContain("run-parked");
  });

  test("a duplicate signal delivery after the watcher resumes does not double-drive the run", async () => {
    const baseDir = await makeTempDir("watcher-dedup-");
    const {
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
    } = await genesisGateDeployment(baseDir);
    await commitParkedRun(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
    );

    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
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

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
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
      recoverParkedRun: makeGateRecoverHook(),
    });

    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    await deliverGoSignal(supervisorSender, "run-parked", "sig-1");
    await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "first resume -> RunCompleted",
    );

    // A retried/racing duplicate of the SAME approval lands after the watcher
    // already resumed and removed itself. It must not re-drive the run: the
    // signal channel dedups the commit by signalId, and no watcher remains to
    // react. The committed log stays at exactly one terminal event.
    await deliverGoSignal(supervisorSender, "run-parked", "sig-1");
    await new Promise((r) => setTimeout(r, 60));
    const finalLog = await readRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
    );
    expect(countKind(finalLog, "RunCompleted")).toBe(1);
    expect(countKind(finalLog, "StepCompleted")).toBe(1);
    expect(countKind(finalLog, "SignalReceived")).toBe(1);

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    await runPromise;
  });

  test("an unsignaled parked watcher is torn down on shutdown without leaking its subscribe iterator", async () => {
    const baseDir = await makeTempDir("watcher-teardown-");
    const base = await genesisGateDeployment(baseDir);
    const { substrate: tracked, live } = trackSubscriptions(base.substrate);
    await commitParkedRun(
      base.substrate,
      base.principal,
      base.workflowRunRepoId,
      "run-parked",
    );

    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const env = parseSpawnTimeEnv(
      makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
    );
    const bindings = buildGateBindings({
      substrate: tracked,
      principal: base.principal,
      workflowRunRepoId: base.workflowRunRepoId,
      workflowDefinitionRepoId: base.workflowDefinitionRepoId,
      childKeyPair,
    });

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
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
      recoverParkedRun: makeGateRecoverHook(),
    });

    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);
    // The watcher subscribed to the gate's signal source; its live tail is open.
    await pollRunLog(
      base.substrate,
      base.principal,
      base.workflowRunRepoId,
      "run-parked",
      () => live() >= 1,
      "watcher subscribe iterator open",
    ).catch(() => undefined);
    expect(live()).toBeGreaterThanOrEqual(1);

    // No signal ever arrives. Shutdown must abort the watcher and tear its
    // subscribe iterator down — otherwise `runWorkflowChild`'s finally would
    // hang on the watcher's `done` (the test would time out).
    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;

    expect(live()).toBe(0);
    expect(result.resumedRunIds).not.toContain("run-parked");
    // The run was never driven — it stayed parked.
    const finalLog = await readRunLog(
      base.substrate,
      base.principal,
      base.workflowRunRepoId,
      "run-parked",
    );
    expect(countKind(finalLog, "RunCompleted")).toBe(0);
  });

  // Regression guard for the (A) "workflows break on restart" failure: a run
  // parked at an awaitSignal gate used to wedge the strictly-serial dispatch
  // loop so NEW runs never dispatched. With the watcher, the parked run is kept
  // parked (not a failed runtimeRun) and a freshly triggered run dispatches and
  // runs alongside it; both reach terminal.
  test("a parked watcher does not block a freshly triggered run from dispatching and completing", async () => {
    const baseDir = await makeTempDir("watcher-coexist-");
    const {
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
    } = await genesisGateDeployment(baseDir);
    await commitParkedRun(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
    );
    // The fresh run's trigger reads its inbound mail from a claim-check entry.
    await seedProcessingEntryInDir(substrate.getRepoDir(workflowRunRepoId), {
      address: "deployment-gate@example.com",
      messageId: "msg-fresh",
      receivedAt: 1,
      text: "kick off",
    });

    const supervisorKeyPair = await generateKeyPair();
    const childKeyPair = await generateKeyPair();
    const channelId = generateChannelId();
    const hmacKey = generateHmacKey();
    const env = parseSpawnTimeEnv({
      ...makeSpawnEnv({
        channelId,
        hmacKeyHex: hexEncode(hmacKey),
        hostPubKeyHex: hexEncode(supervisorKeyPair.publicKey),
      }),
      MAILBOX_ADDRESS: "deployment-gate@example.com",
    });
    const bindings = buildGateBindings({
      substrate,
      principal,
      workflowRunRepoId,
      workflowDefinitionRepoId,
      childKeyPair,
    });

    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventStream = createMemoryFrameStream();
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
      recoverParkedRun: makeGateRecoverHook(),
    });

    await waitForTriggeredRun(childToSupervisor, (lines) => lines.length > 0);

    // Dispatch a fresh run while the parked watcher is live. The control loop
    // must process the trigger (it is NOT wedged by the parked run).
    await supervisorSender.send({
      type: "trigger.fire",
      data: { runId: "run-fresh", messageId: "msg-fresh", receivedAt: 1 },
    });
    await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-fresh",
      (log) => log.some((e) => e.kind === "RunStarted"),
      "fresh run dispatched (RunStarted)",
    );

    // The fresh run parks at its own gate on the LIVE in-process signal channel;
    // approving it drives it to completion (the normal awaitSignal happy path).
    await deliverGoSignal(supervisorSender, "run-fresh", "sig-fresh");
    const freshLog = await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-fresh",
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "fresh run -> RunCompleted",
    );
    expect(countKind(freshLog, "RunCompleted")).toBe(1);

    // And the parked run still resumes via its watcher when its own signal
    // lands — proving the two coexist and the parked run reaches terminal
    // (the dispatch entry that would otherwise wedge the loop settles).
    await deliverGoSignal(supervisorSender, "run-parked", "sig-parked");
    const parkedLog = await pollRunLog(
      substrate,
      principal,
      workflowRunRepoId,
      "run-parked",
      (log) => log.some((e) => e.kind === "RunCompleted"),
      "parked run -> RunCompleted",
    );
    expect(countKind(parkedLog, "RunCompleted")).toBe(1);

    await supervisorSender.send({
      type: "shutdown",
      data: { reason: "test done" },
    });
    supervisorToChild.close();
    const result = await runPromise;

    expect(result.triggeredRunIds).toContain("run-fresh");
    expect(result.resumedRunIds).not.toContain("run-parked");
  });
});
