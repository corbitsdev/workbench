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
import { createSessionManager } from "./session-manager";
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "idle-evict-test-"));
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

type IdleHarness = {
  manager: ReturnType<typeof createSessionManager>;
  repoStore: ReturnType<typeof createAgentRepoStore>;
  built: BuiltHarness[];
  removeCalls: string[];
  setClock: (ms: number) => void;
  advance: (ms: number) => void;
};

async function makeIdleHarness(
  dataDir: string,
  opts: { idleEvictMs: number; gateBuild?: () => Promise<void> } = {
    idleEvictMs: 60_000,
  },
): Promise<IdleHarness> {
  const baseRepoStore = createAgentRepoStore({ dataDir });
  const removeCalls: string[] = [];
  // Proxy the repo store so eviction's non-deletion of the agent dir is
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
    generateKeyPair: async () => makeKeyPair(11),
    signEd25519: async () => new Uint8Array(64),
    verifySSHSig: async () => true,
  });
  const transport = createInMemoryTransport();
  const built: BuiltHarness[] = [];

  let clock = 1_000_000;

  const builder: HarnessBuilder = {
    canBuildSource() {
      /* accept every source */
    },
    async build(args) {
      if (opts.gateBuild !== undefined) await opts.gateBuild();
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
    now: () => clock,
    idleEvictMs: opts.idleEvictMs,
  });

  return {
    manager,
    repoStore: baseRepoStore,
    built,
    removeCalls,
    setClock: (ms: number) => {
      clock = ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
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

describe("SessionManager idle eviction — core lifecycle", () => {
  test("evicts an idle agent to wakeable, preserving history, and rewakes on the next message with the prior INBOX intact", async () => {
    const dataDir = await tempDir();
    const h = await makeIdleHarness(dataDir, { idleEvictMs: 60_000 });
    const addr = "agent@local";

    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    // First message while live — persisted to the durable mail repo.
    h.manager.deliverInboundMail(addr, makeRawMessage("<msg-1@test>"));

    const agentDir = h.repoStore.getAgentDir(addr);
    await waitFor(
      async () => (await listMail(agentDir)).length >= 1,
      "msg-1 persisted",
    );

    // Idle past the threshold, then sweep.
    h.advance(60_001);
    await h.manager.evictIdleSessions();

    expect(h.manager.hasSession(addr)).toBe(false);
    expect(h.manager.isWakeable(addr)).toBe(true);
    expect(h.built).toHaveLength(1);
    expect(h.built[0]?.closed).toBe(true);
    expect(h.built[0]?.disposed).toBe(true);
    // Eviction must NOT delete the agent directory — the durable state is
    // what the wake rebuilds from.
    expect(h.removeCalls).toHaveLength(0);
    expect(fs.existsSync(agentDir)).toBe(true);
    expect((await listMail(agentDir)).map((m) => m.messageId)).toContain(
      "<msg-1@test>",
    );

    // Next message wakes the agent through the existing rails.
    h.manager.deliverInboundMail(addr, makeRawMessage("<msg-2@test>"));
    await waitFor(() => h.manager.hasSession(addr), "rewoken");

    expect(h.built).toHaveLength(2);
    // The fresh harness is built against the SAME on-disk directory.
    expect(h.built[1]?.storeDir).toBe(h.built[0]?.storeDir);

    await waitFor(
      async () => (await listMail(agentDir)).length >= 2,
      "msg-2 replayed to fresh harness",
    );
    const ids = (await listMail(agentDir)).map((m) => m.messageId);
    expect(ids).toContain("<msg-1@test>");
    expect(ids).toContain("<msg-2@test>");
  });
});

describe("SessionManager idle eviction — deferral conditions", () => {
  test("does not evict while a turn is running, evicts once it completes", async () => {
    const dataDir = await tempDir();
    const h = await makeIdleHarness(dataDir, { idleEvictMs: 60_000 });
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

    h.advance(60_001);
    await h.manager.evictIdleSessions();
    expect(h.manager.hasSession(addr)).toBe(true);

    emit({
      type: "message.run.ended",
      seq: 2,
      data: { messageRunId: "r1", messageId: "m1", status: "completed" },
    });

    h.advance(60_001);
    await h.manager.evictIdleSessions();
    expect(h.manager.hasSession(addr)).toBe(false);
    expect(h.manager.isWakeable(addr)).toBe(true);
  });

  test("does not evict while an in-process event subscriber is attached", async () => {
    const dataDir = await tempDir();
    const h = await makeIdleHarness(dataDir, { idleEvictMs: 60_000 });
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    const dispose = h.manager.onAgentEvent(addr, () => {});

    h.advance(60_001);
    await h.manager.evictIdleSessions();
    expect(h.manager.hasSession(addr)).toBe(true);

    dispose();
    h.advance(60_001);
    await h.manager.evictIdleSessions();
    expect(h.manager.hasSession(addr)).toBe(false);
  });

  test("does not disturb an agent whose harness build is still in flight", async () => {
    const dataDir = await tempDir();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await makeIdleHarness(dataDir, {
      idleEvictMs: 60_000,
      gateBuild: () => gate,
    });
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    // provisionAgent leaves the agent provisioned-not-live; drive a wake by
    // routing it through restore so it is wakeable, then trigger a build.
    // Simpler: start the session build but hold it at the gate.
    const starting = h.manager.startSession(addr);

    h.advance(60_001);
    await h.manager.evictIdleSessions();
    // The build has not completed, so there is no live session to evict and
    // the sweep is a no-op that does not reject or tear the pending build down.
    expect(h.manager.hasSession(addr)).toBe(false);

    release();
    await starting;
    expect(h.manager.hasSession(addr)).toBe(true);
    expect(h.built).toHaveLength(1);
  });

  test("idleEvictMs of 0 disables eviction entirely", async () => {
    const dataDir = await tempDir();
    const h = await makeIdleHarness(dataDir, { idleEvictMs: 0 });
    const addr = "agent@local";
    await h.manager.provisionAgent(makeConfig(addr));
    await h.manager.startSession(addr);

    h.advance(10_000_000);
    await h.manager.evictIdleSessions();
    expect(h.manager.hasSession(addr)).toBe(true);
  });
});
