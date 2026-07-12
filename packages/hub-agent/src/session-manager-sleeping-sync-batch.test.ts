// WORKBENCH-LOCAL (CL-3409): a sidecar reconnect fans updateGrants /
// updateSources out to every wakeable (sleeping) agent within a few
// milliseconds of each other — dozens of near-simultaneous per-agent INF
// lines that drowned a real outlier. This guards the batched summary +
// outlier-WARN replacement in session-manager.ts.
import { afterEach, describe, expect, mock, test } from "bun:test";
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
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";

const infoSpy = mock((..._args: unknown[]) => {});
const warnSpy = mock((..._args: unknown[]) => {});
const debugSpy = mock((..._args: unknown[]) => {});

mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: infoSpy,
    warn: warnSpy,
    error: () => {},
    debug: debugSpy,
  }),
}));

// session-manager.ts resolves the module-level `logger` via `getLogger` at
// import time, so the mock above must land before this dynamic import.
const { createAgentKeyStore } = await import("./agent-key-store");
const { createAgentRepoStore } = await import("./agent-repo-store");
const { createSessionManager } = await import("./session-manager");

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "cl3409-sync-batch-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  infoSpy.mockClear();
  warnSpy.mockClear();
  debugSpy.mockClear();
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
    start: () => {},
    stop: () => {},
    close: async () => {},
    deliver: () => {},
    setSource: () => {},
    setSources: () => {},
  } as unknown as Harness;
  const mailStore = {
    async commitMail() {
      return null;
    },
  } as unknown as MailAuditStore;
  return {
    harness,
    mailStore,
    updateGrants() {},
    disposers: [],
  };
}

function makeBuilder(): HarnessBuilder {
  return {
    canBuildSource: () => {},
    async build() {
      return makeBundle();
    },
  } as unknown as HarnessBuilder;
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

function makeManager(dataDir: string, sleepingSyncFlushDelayMs: number) {
  const { repoStore, keyStore } = makeStores(dataDir);
  const transport = createInMemoryTransport();
  return createSessionManager({
    transport,
    repoStore,
    keyStore,
    buildHarness: makeBuilder(),
    createAgentCrypto: (kp) => makeCrypto(kp),
    onEvent: () => {},
    onConnectorStateChanged: () => {},
    sleepingSyncFlushDelayMs,
  });
}

async function seedAgentsOnDisk(
  dataDir: string,
  addresses: string[],
): Promise<void> {
  const seed = makeManager(dataDir, 10);
  for (const address of addresses) {
    await seed.provisionAgent(makeConfig(address));
    await seed.startSession(address);
  }
}

function grant(id: string) {
  return {
    id,
    resource: "*",
    action: "*",
    effect: "allow" as const,
    origin: "system" as const,
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconstructs the interpolated string from a `logger.x\`...\`` tagged-template call. */
function renderTag(call: unknown[]): string {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

describe("session-manager sleeping-agent sync batching", () => {
  test("uniform batch: one summary INF line, per-agent lines demoted, no outlier WARN", async () => {
    const dataDir = await tempDir();
    const addresses = ["a@local", "b@local", "c@local"];
    await seedAgentsOnDisk(dataDir, addresses);
    const manager = makeManager(dataDir, 10);
    await manager.restoreSessions();

    for (const address of addresses) {
      await manager.updateGrants(address, [grant("g"), grant("g2")]);
    }
    await waitFor(50);

    const infoLines = infoSpy.mock.calls.map(renderTag);
    const summaryLines = infoLines.filter((l) => l.includes("Synced"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain("3 sleeping agents");
    expect(summaryLines[0]).toContain("min=2");
    expect(summaryLines[0]).toContain("max=2");

    // Per-agent lines no longer land at INF.
    expect(infoLines.some((l) => l.includes("Updated grants for sleeping"))).toBe(
      false,
    );
    expect(debugSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("flags a grant-count outlier at WARN without losing the summary", async () => {
    const dataDir = await tempDir();
    const addresses = ["a@local", "b@local", "c@local", "d@local"];
    await seedAgentsOnDisk(dataDir, addresses);
    const manager = makeManager(dataDir, 10);
    await manager.restoreSessions();

    const rules104 = Array.from({ length: 104 }, (_, i) => grant(`g${i}`));
    await manager.updateGrants("a@local", rules104);
    await manager.updateGrants("b@local", rules104);
    await manager.updateGrants("c@local", rules104);
    await manager.updateGrants("d@local", [grant("only-one")]);
    await waitFor(50);

    const summaryLines = infoSpy.mock.calls
      .map(renderTag)
      .filter((l) => l.includes("Synced"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain("4 sleeping agents");

    const warnLines = warnSpy.mock.calls.map(renderTag);
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain("outlier");
    expect(warnLines[0]).toContain("d@local");
  });
});
