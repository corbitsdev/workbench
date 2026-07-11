import { describe, test, expect, afterEach } from "bun:test";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInMemoryTransport } from "@intx/mail-memory";
import { createMailAuditStore, listMail } from "@workbench/storage-isogit";
import type { Harness } from "@intx/harness";
import type {
  CryptoProvider,
  HarnessConfig,
  InferenceEvent,
  KeyPair,
} from "@intx/types/runtime";

import { createAgentKeyStore } from "./agent-key-store";
import { createAgentRepoStore } from "./agent-repo-store";
import { createSessionManager, NoActiveTurnError } from "./session-manager";
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "abort-turn-test-"));
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

function makeRawMessage(messageId: string): Uint8Array {
  const lines = [
    `Message-ID: ${messageId}`,
    "From: sender@example.com",
    "To: agent@local",
    `Date: ${new Date().toUTCString()}`,
    "",
    "body",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

type BuiltHarness = {
  address: string;
  storeDir: string;
  onEvent: (event: InferenceEvent) => void;
  closed: boolean;
  disposed: boolean;
};

type AbortHarness = {
  manager: ReturnType<typeof createSessionManager>;
  repoStore: ReturnType<typeof createAgentRepoStore>;
  built: BuiltHarness[];
  removeCalls: string[];
};

async function makeAbortHarness(dataDir: string): Promise<AbortHarness> {
  const baseRepoStore = createAgentRepoStore({ dataDir });
  const removeCalls: string[] = [];
  // Proxy the repo store so the abort's non-deletion of the agent dir is
  // asserted from a real signal, not a mock we fed.
  const repoStore = new Proxy(baseRepoStore, {
    get(target, prop, receiver) {
      if (prop === "remove") {
        return async (address: string) => {
          removeCalls.push(address);
          return target.remove(address);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const keyStore = createAgentKeyStore({
    dataDir,
    generateKeyPair: async () => makeKeyPair(7),
    signEd25519: async () => new Uint8Array(64),
    verifySSHSig: async () => true,
  });
  const transport = createInMemoryTransport();
  const built: BuiltHarness[] = [];

  const builder: HarnessBuilder = {
    canBuildSource() {
      /* accept every source */
    },
    async build(args) {
      const mailStore = await createMailAuditStore(args.storeDir);
      const rec: BuiltHarness = {
        address: args.agentAddress,
        storeDir: args.storeDir,
        onEvent: args.onEvent,
        closed: false,
        disposed: false,
      };
      built.push(rec);
      const harness = {
        deliver: () => {
          /* inbound mail is routed via the transport, not here */
        },
        setSource: () => {},
        setSources: () => {},
        async close() {
          rec.closed = true;
        },
        get blobReader(): never {
          throw new Error("blobReader unused");
        },
      } as unknown as Harness;
      const bundle: HarnessBundle = {
        harness,
        mailStore,
        updateGrants() {},
        disposers: [
          async () => {
            rec.disposed = true;
          },
        ],
      };
      return bundle;
    },
  };

  const manager = createSessionManager({
    transport,
    repoStore,
    keyStore,
    buildHarness: builder,
    createAgentCrypto: (kp) => makeCrypto(kp),
    onEvent: () => {},
    onConnectorStateChanged: () => {},
  });

  return { manager, repoStore: baseRepoStore, built, removeCalls };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function startRun(h: AbortHarness, runId: string): void {
  const emit = h.built.at(-1)?.onEvent;
  if (emit === undefined) throw new Error("no harness built");
  emit({
    type: "message.run.started",
    seq: 1,
    data: { messageId: "m1", messageRunId: runId, receivedAt: 0 },
  });
}

describe("SessionManager.abortTurn", () => {
  test("aborts a running turn non-terminally: harness closed, agent wakeable, history preserved, next message rewakes", async () => {
    const dataDir = await tempDir();
    const h = await makeAbortHarness(dataDir);
    const addr = "agent@local";

    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    h.manager.deliverInboundMail(addr, makeRawMessage("<msg-1@test>"));
    const agentDir = h.repoStore.getAgentDir(addr);
    await waitFor(
      async () => (await listMail(agentDir)).length >= 1,
      "msg-1 persisted",
    );

    startRun(h, "run-1");

    await h.manager.abortTurn(addr);

    // The harness (whose close() aborts the in-flight reactor work) is closed
    // and disposed, but the agent is asleep — not destroyed.
    expect(h.built).toHaveLength(1);
    expect(h.built[0]?.closed).toBe(true);
    expect(h.built[0]?.disposed).toBe(true);
    expect(h.manager.hasSession(addr)).toBe(false);
    expect(h.manager.isWakeable(addr)).toBe(true);
    // The abort must NOT delete the agent directory — the conversation
    // history is what the next wake rebuilds from.
    expect(h.removeCalls).toHaveLength(0);
    expect(fs.existsSync(agentDir)).toBe(true);
    expect((await listMail(agentDir)).map((m) => m.messageId)).toContain(
      "<msg-1@test>",
    );

    // The session stays usable: the next message wakes a fresh harness
    // against the same on-disk state.
    h.manager.deliverInboundMail(addr, makeRawMessage("<msg-2@test>"));
    await waitFor(() => h.manager.hasSession(addr), "rewoken");
    expect(h.built).toHaveLength(2);
    expect(h.built[1]?.storeDir).toBe(h.built[0]?.storeDir);
  });

  test("rejects with NoActiveTurnError when the session is live but no turn is running", async () => {
    const dataDir = await tempDir();
    const h = await makeAbortHarness(dataDir);
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    await expect(h.manager.abortTurn(addr)).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    // The live session is untouched.
    expect(h.manager.hasSession(addr)).toBe(true);
    expect(h.built[0]?.closed).toBe(false);
  });

  test("rejects with NoActiveTurnError once the running turn has ended", async () => {
    const dataDir = await tempDir();
    const h = await makeAbortHarness(dataDir);
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    const emit = h.built[0]?.onEvent;
    if (emit === undefined) throw new Error("no harness built");
    emit({
      type: "message.run.started",
      seq: 1,
      data: { messageId: "m1", messageRunId: "r1", receivedAt: 0 },
    });
    emit({
      type: "message.run.ended",
      seq: 2,
      data: { messageRunId: "r1", messageId: "m1", status: "completed" },
    });

    await expect(h.manager.abortTurn(addr)).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    expect(h.manager.hasSession(addr)).toBe(true);
  });

  test("rejects with NoActiveTurnError for a sleeping (wakeable) agent and an unknown address", async () => {
    const dataDir = await tempDir();
    const h = await makeAbortHarness(dataDir);
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    // Put the agent to sleep through the same teardown the abort uses.
    startRun(h, "run-1");
    await h.manager.abortTurn(addr);
    expect(h.manager.isWakeable(addr)).toBe(true);

    await expect(h.manager.abortTurn(addr)).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    // Sleeping state is untouched — the wakeable entry must survive.
    expect(h.manager.isWakeable(addr)).toBe(true);

    await expect(
      h.manager.abortTurn("nobody@nowhere"),
    ).rejects.toBeInstanceOf(NoActiveTurnError);
  });
});
