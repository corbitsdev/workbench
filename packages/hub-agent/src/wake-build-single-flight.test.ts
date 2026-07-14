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
  KeyPair,
} from "@intx/types/runtime";

import { createAgentKeyStore } from "./agent-key-store";
import { createAgentRepoStore } from "./agent-repo-store";
import {
  createSessionManager,
  HarnessBuildTimeoutError,
  type SessionManagerConfig,
} from "./session-manager";
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "wake-single-flight-"));
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

function makeBundle(
  onClose?: () => void,
  disposers: (() => Promise<void>)[] = [],
): HarnessBundle {
  const harness = {
    start: () => undefined,
    stop: () => undefined,
    close: async () => {
      onClose?.();
    },
    deliver: () => undefined,
    setSource: () => undefined,
    setSources: () => undefined,
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
    disposers,
  };
}

function makeStores(dataDir: string) {
  return {
    repoStore: createAgentRepoStore({ dataDir }),
    keyStore: createAgentKeyStore({
      dataDir,
      generateKeyPair: async () => makeKeyPair(11),
      signEd25519: async () => new Uint8Array(64),
      verifySSHSig: async () => true,
    }),
  };
}

function makeManager(
  dataDir: string,
  builder: HarnessBuilder,
  overrides: Partial<SessionManagerConfig> = {},
) {
  const { repoStore, keyStore } = makeStores(dataDir);
  const transport = createInMemoryTransport();
  const manager = createSessionManager({
    transport,
    repoStore,
    keyStore,
    buildHarness: builder,
    createAgentCrypto: (kp) => makeCrypto(kp),
    onEvent: () => {},
    onConnectorStateChanged: () => {},
    ...overrides,
  });
  return { manager, transport };
}

async function seedAgentOnDisk(
  dataDir: string,
  address: string,
): Promise<void> {
  const builder: HarnessBuilder = {
    canBuildSource() {},
    async build() {
      return makeBundle();
    },
  };
  const seed = makeManager(dataDir, builder);
  await seed.manager.provisionAgent(makeConfig(address));
  await seed.manager.startSession(address);
}

describe("wake build single-flight", () => {
  test("two concurrent wakes for one address build the harness exactly once", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentOnDisk(dataDir, address);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildStarts: string[] = [];
    const builder: HarnessBuilder = {
      canBuildSource() {},
      async build(args) {
        buildStarts.push(args.agentAddress);
        await gate;
        return makeBundle();
      },
    };
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    const first = manager.wakeAgent(address);
    const second = manager.wakeAgent(address);
    // Let both wake calls reach the (gated) build before releasing.
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(buildStarts).toEqual([address]);
    expect(manager.hasSession(address)).toBe(true);
  });

  test("a build that never settles fails loudly within the bound and leaves the agent wakeable", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentOnDisk(dataDir, address);

    let buildCount = 0;
    const builder: HarnessBuilder = {
      canBuildSource() {},
      build() {
        buildCount += 1;
        // Never settles — the wedge the guard must break.
        return new Promise<HarnessBundle>(() => {});
      },
    };
    const { manager } = makeManager(dataDir, builder, {
      buildTimeoutMs: 25,
      wakeMaxAttempts: 1,
    });
    await manager.restoreSessions();

    const started = Date.now();
    const err = await manager.wakeAgent(address).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(HarnessBuildTimeoutError);
    expect(elapsed).toBeLessThan(2000);
    expect(buildCount).toBe(1);
    expect(manager.hasSession(address)).toBe(false);
    // The agent stays in the wakeable state so a later trigger retries —
    // though a build wedged on a held resource (e.g. the agent-dir lock) will
    // wedge again; the guard bounds and reports the failure, it cannot
    // release what the abandoned build holds.
    expect(manager.isWakeable(address)).toBe(true);
  });

  test("after a timed-out attempt the wake retries with a fresh build and succeeds", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentOnDisk(dataDir, address);

    let buildCount = 0;
    const builder: HarnessBuilder = {
      canBuildSource() {},
      build() {
        buildCount += 1;
        if (buildCount === 1) {
          // Attempt 1 wedges; the guard must abandon it and retry.
          return new Promise<HarnessBundle>(() => {});
        }
        return Promise.resolve(makeBundle());
      },
    };
    const { manager } = makeManager(dataDir, builder, {
      buildTimeoutMs: 25,
      wakeMaxAttempts: 2,
      sleep: () => Promise.resolve(),
    });
    await manager.restoreSessions();

    await manager.wakeAgent(address);

    expect(buildCount).toBe(2);
    expect(manager.hasSession(address)).toBe(true);
  });

  test("a build that resolves after the timeout is disposed, not installed", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentOnDisk(dataDir, address);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false;
    let disposed = false;
    let signalDisposed!: () => void;
    const disposedSignal = new Promise<void>((resolve) => {
      signalDisposed = resolve;
    });
    const builder: HarnessBuilder = {
      canBuildSource() {},
      async build() {
        await gate;
        return makeBundle(() => {
          closed = true;
        }, [
          async () => {
            disposed = true;
            signalDisposed();
          },
        ]);
      },
    };
    const { manager } = makeManager(dataDir, builder, {
      buildTimeoutMs: 25,
      wakeMaxAttempts: 1,
    });
    await manager.restoreSessions();

    const err = await manager.wakeAgent(address).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HarnessBuildTimeoutError);
    expect(manager.hasSession(address)).toBe(false);

    // The build lands only now — after the guard abandoned it.
    release();
    await disposedSignal;
    expect(closed).toBe(true);
    expect(disposed).toBe(true);
    expect(manager.hasSession(address)).toBe(false);
  });
});
