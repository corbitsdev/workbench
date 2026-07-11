import { describe, test, expect, afterEach } from "bun:test";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInMemoryTransport } from "@intx/mail-memory";
import type { MailAuditStore } from "@workbench/storage-isogit";
import type { Harness } from "@intx/harness";
import type {
  CryptoProvider,
  HarnessConfig,
  InferenceEvent,
  KeyPair,
} from "@intx/types/runtime";

import { createAgentKeyStore } from "./agent-key-store";
import { createAgentRepoStore } from "./agent-repo-store";
import { createSessionManager } from "./session-manager";
import type {
  BuildHarnessArgs,
  HarnessBuilder,
  HarnessBundle,
} from "./harness-builder";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-loop-test-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((d) => fsp.rm(d, { recursive: true, force: true })),
  );
});

function makeKeyPair(seed: number): KeyPair {
  const privateKey = new Uint8Array(32);
  const publicKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    privateKey[i] = (seed + i) & 0xff;
    publicKey[i] = (seed * 2 + i) & 0xff;
  }
  return { privateKey, publicKey };
}

function makeConfig(address: string): HarnessConfig {
  return {
    agentId: "test-agent",
    agentAddress: address,
    sessionId: "sess-1",
    principalId: "principal-1",
    tenantId: "tenant-1",
    systemPrompt: "test",
    tools: [],
    grants: [],
    sources: [
      {
        id: "test:test-model",
        provider: "test",
        apiKey: "key",
        baseURL: "http://localhost",
        model: "test-model",
      },
    ],
    defaultSource: "test:test-model",
  };
}

function makeCrypto(kp: KeyPair): CryptoProvider {
  return {
    async sign() {
      return new Uint8Array(64);
    },
    async signSSH() {
      return "unused";
    },
    async verify() {
      return true;
    },
    getPublicKey: () => kp.publicKey,
  };
}

function makeBundle(): HarnessBundle {
  const harness = {
    start: () => {
      /* no-op */
    },
    stop: () => {
      /* no-op */
    },
    close: async () => {
      /* no-op: eviction closes the harness */
    },
    deliver: () => {
      /* no-op */
    },
    setSource: () => {
      /* no-op */
    },
    setSources: () => {
      /* no-op */
    },
  } as unknown as Harness;
  const mailStore = {
    async commitMail() {
      return null;
    },
  } as unknown as MailAuditStore;
  return {
    harness,
    mailStore,
    updateGrants() {
      /* no-op */
    },
    disposers: [],
  };
}

type Fixture = {
  manager: ReturnType<typeof createSessionManager>;
  buildCalls: BuildHarnessArgs[];
  forwarded: InferenceEvent[];
  emit: (event: InferenceEvent) => void;
};

async function makeFixture(address: string): Promise<Fixture> {
  const dataDir = await tempDir();
  const buildCalls: BuildHarnessArgs[] = [];
  const builder: HarnessBuilder = {
    canBuildSource() {
      /* accept every source */
    },
    async build(args) {
      buildCalls.push(args);
      return makeBundle();
    },
  };
  const forwarded: InferenceEvent[] = [];
  const manager = createSessionManager({
    transport: createInMemoryTransport(),
    repoStore: createAgentRepoStore({ dataDir }),
    keyStore: createAgentKeyStore({
      dataDir,
      generateKeyPair: async () => makeKeyPair(11),
      signEd25519: async () => new Uint8Array(64),
      verifySSHSig: async () => true,
    }),
    buildHarness: builder,
    createAgentCrypto: (kp) => makeCrypto(kp),
    onEvent: (_addr, _sid, event) => forwarded.push(event),
    onConnectorStateChanged: () => {
      /* no-op */
    },
  });
  await manager.provisionAgent(makeConfig(address));
  await manager.startSession(address);
  const call = buildCalls[0];
  if (call === undefined) throw new Error("builder was not invoked");
  return {
    manager,
    buildCalls,
    forwarded,
    emit: (event) => {
      call.onEvent(event);
    },
  };
}

function runStarted(seq: number): InferenceEvent {
  return {
    type: "message.run.started",
    seq,
    data: { messageId: "msg-1", messageRunId: "run-1", receivedAt: 0 },
  };
}

function inferenceDone(seq: number, text: string): InferenceEvent {
  return {
    type: "inference.done",
    seq,
    data: {
      turn: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "test-model",
        timestamp: 0,
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: {
        sourceId: "test:test-model",
        provider: "test",
        model: "test-model",
      },
    },
  };
}

function inboundMessage(id: string, to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: external@remote.interchange",
      `To: ${to}`,
      "Date: Thu, 17 Apr 2026 12:00:00 +0000",
      `Message-ID: <${id}@remote.interchange>`,
      "Subject: hi",
      "Content-Type: text/plain",
      "",
      "body",
    ].join("\r\n"),
  );
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("SessionManager assistant output loop guard", () => {
  test("third identical output is swallowed, the turn ends interrupted, and the session sleeps but stays usable", async () => {
    const address = "loop@local";
    const fx = await makeFixture(address);

    fx.emit(runStarted(1));
    fx.emit(inferenceDone(2, "I did the thing."));
    fx.emit(inferenceDone(3, "I did the thing."));
    fx.emit(inferenceDone(4, "I did the thing."));

    const doneEvents = fx.forwarded.filter((e) => e.type === "inference.done");
    expect(doneEvents).toHaveLength(2);

    const ended = fx.forwarded.find((e) => e.type === "message.run.ended");
    if (ended === undefined || ended.type !== "message.run.ended") {
      throw new Error("expected a synthetic message.run.ended");
    }
    expect(ended.data.status).toBe("failed");
    expect(ended.data.messageRunId).toBe("run-1");
    expect(ended.data.messageId).toBe("msg-1");
    expect(ended.data.error?.kind).toBe("assistant_loop_interrupted");
    expect(ended.data.error?.message).toContain("3");

    await until(() => !fx.manager.hasSession(address), "session eviction");

    // Later reactor events from the aborting harness are dropped.
    const countBefore = fx.forwarded.length;
    fx.emit(inferenceDone(5, "I did the thing."));
    expect(fx.forwarded).toHaveLength(countBefore);

    // A new user message wakes the agent: the session stays usable.
    fx.manager.deliverInboundMail(address, inboundMessage("m1", address));
    await until(() => fx.buildCalls.length === 2, "wake rebuild");
    await until(() => fx.manager.hasSession(address), "session live again");
  });

  test("differing outputs are all forwarded and the session stays live", async () => {
    const address = "vary@local";
    const fx = await makeFixture(address);

    fx.emit(runStarted(1));
    fx.emit(inferenceDone(2, "step one"));
    fx.emit(inferenceDone(3, "step two"));
    fx.emit(inferenceDone(4, "step three"));
    fx.emit(inferenceDone(5, "step one"));

    expect(
      fx.forwarded.filter((e) => e.type === "inference.done"),
    ).toHaveLength(4);
    expect(
      fx.forwarded.filter((e) => e.type === "message.run.ended"),
    ).toHaveLength(0);
    expect(fx.manager.hasSession(address)).toBe(true);
  });

  test("a user message resets the counter", async () => {
    const address = "reset@local";
    const fx = await makeFixture(address);

    fx.emit(runStarted(1));
    fx.emit(inferenceDone(2, "same answer"));
    fx.emit(inferenceDone(3, "same answer"));

    fx.manager.deliverInboundMail(address, inboundMessage("m1", address));

    fx.emit(inferenceDone(4, "same answer"));
    fx.emit(inferenceDone(5, "same answer"));

    expect(
      fx.forwarded.filter((e) => e.type === "message.run.ended"),
    ).toHaveLength(0);
    expect(fx.manager.hasSession(address)).toBe(true);
  });
});
