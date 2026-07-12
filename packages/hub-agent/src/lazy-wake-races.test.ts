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
import { createSessionManager } from "./session-manager";
import type { HarnessBuilder, HarnessBundle } from "./harness-builder";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "critique-lazy-wake-"));
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
      /* no-op: destroySession closes the harness during the F2 teardown */
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

function makeControlledBuilder(opts: { gate?: Promise<void> }): {
  builder: HarnessBuilder;
  buildStarts: string[];
  builtConfigs: HarnessConfig[];
  liveGrantUpdates: number[][];
} {
  const buildStarts: string[] = [];
  const builtConfigs: HarnessConfig[] = [];
  // Each entry is the grant-count sequence a built bundle received via
  // updateGrants — the observable proof a mid-wake update reached the
  // live session.
  const liveGrantUpdates: number[][] = [];
  const builder: HarnessBuilder = {
    canBuildSource() {
      /* accept every source */
    },
    async build(args) {
      buildStarts.push(args.agentAddress);
      builtConfigs.push(args.agentConfig);
      if (opts.gate !== undefined) await opts.gate;
      const bundle = makeBundle();
      const received: number[] = [];
      liveGrantUpdates.push(received);
      bundle.updateGrants = (grants) => {
        received.push(grants.length);
      };
      return bundle;
    },
  };
  return { builder, buildStarts, builtConfigs, liveGrantUpdates };
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
  opts: {
    sleep?: (ms: number) => Promise<void>;
    onMailDeliveryFailed?: (
      agentAddress: string,
      info: { parkedCount: number; cause: string },
    ) => void;
  } = {},
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
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.onMailDeliveryFailed !== undefined
      ? { onMailDeliveryFailed: opts.onMailDeliveryFailed }
      : {}),
  });
  return { manager, transport };
}

async function seedAgentsOnDisk(
  dataDir: string,
  addresses: string[],
): Promise<void> {
  const { builder } = makeControlledBuilder({});
  const seed = makeManager(dataDir, builder);
  for (const address of addresses) {
    await seed.manager.provisionAgent(makeConfig(address));
    await seed.manager.startSession(address);
  }
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

describe("critique: lazy wake races", () => {
  test("mail parked during a session.start-triggered wake is drained after the wake", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { builder } = makeControlledBuilder({ gate });
    const { manager, transport } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    // Wake initiated by session.start (hub-link handleSessionStart path),
    // NOT by deliverInboundMail.
    const wake = manager.wakeAgent(address);
    // Mail arrives while that build is in flight: parked.
    manager.deliverInboundMail(address, inboundMessage("m1", address));
    release();
    await wake;
    // Give any drain microtasks a chance.
    await Promise.resolve();
    await Promise.resolve();

    const agentTransport = transport.getTransportFor(address);
    const refs = await agentTransport.search("INBOX", {});
    expect(refs.length).toBe(1);
  });

  test("destroySession during an in-flight wake prevents the session from going live", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { builder } = makeControlledBuilder({ gate });
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    const wake = manager.wakeAgent(address);
    // Let the wake reach the (gated) harness build.
    await Promise.resolve();
    await Promise.resolve();

    // Undeploy arrives mid-build. destroySession sees the wakeable entry
    // and returns success ("Removed wakeable agent").
    await manager.destroySession(address);

    release();
    await wake.catch(() => {});

    // The agent was destroyed; no live session should exist afterwards.
    expect(manager.hasSession(address)).toBe(false);
  });

  test("grants updated while an agent sleeps persist and apply on wake", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    const { builder, builtConfigs } = makeControlledBuilder({});
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    const grant = {
      id: "g-1",
      resource: "*",
      action: "*",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: null,
    };
    // The agent is sleeping (wakeable, no session): the update must land
    // in the stored config and on disk, not throw and not force a wake.
    await manager.updateGrants(address, [grant]);
    expect(manager.hasSession(address)).toBe(false);

    // Persisted: a fresh scan of agent.json carries the new grant.
    const { repoStore } = makeStores(dataDir);
    const configs = await repoStore.scanConfigs();
    const persisted = configs.find((c) => c.address === address);
    expect(persisted?.config.grants).toHaveLength(1);

    // Applied: the eventual wake builds with the updated grants.
    await manager.wakeAgent(address);
    expect(builtConfigs).toHaveLength(1);
    expect(builtConfigs[0]?.grants).toHaveLength(1);
    expect(builtConfigs[0]?.grants[0]?.id).toBe("g-1");
  });

  test("destroying a provisioned agent clears its lazy-restore state", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    const { builder, buildStarts } = makeControlledBuilder({});
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    // Mail arrives for the sleeping agent... but the wake is beaten by a
    // provision + destroy for the same address. The parked message must
    // not resurrect the destroyed agent through a later wake.
    await manager.provisionAgent(makeConfig(address));
    await manager.destroySession(address);

    expect(manager.isWakeable(address)).toBe(false);
    await expect(manager.wakeAgent(address)).rejects.toThrow(
      /No wakeable agent/,
    );
    expect(buildStarts).toEqual([]);
  });

  test("grants updated during an in-flight wake are enforced on the live session", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { builder, builtConfigs, liveGrantUpdates } = makeControlledBuilder({
      gate,
    });
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    const wake = manager.wakeAgent(address);
    // Let the wake reach the (gated) harness build.
    await Promise.resolve();
    await Promise.resolve();

    // A grant revocation-style update lands mid-build. It must not be
    // discarded when the wake completes with the pre-update snapshot.
    const grant = {
      id: "g-mid-wake",
      resource: "*",
      action: "*",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: null,
    };
    await manager.updateGrants(address, [grant]);

    release();
    await wake;

    // The build itself ran against the snapshot (0 grants)...
    expect(builtConfigs[0]?.grants).toHaveLength(0);
    // ...so the updated grants must have been re-applied to the live
    // session's bundle after the build landed.
    expect(liveGrantUpdates[0]).toEqual([1]);
    expect(manager.hasSession(address)).toBe(true);
  });

  test("a deploy racing an in-flight wake yields exactly one live session — the new one", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { builder, buildStarts } = makeControlledBuilder({ gate });
    const { manager } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    const wake = manager.wakeAgent(address);
    // Let the wake reach the (gated) harness build.
    await Promise.resolve();
    await Promise.resolve();

    // A fresh deploy for the same address supersedes the in-flight wake.
    await manager.provisionAgent(makeConfig(address));
    // session.start for the deploy: waits out the doomed wake, then
    // builds the new session.
    const start = manager.startSession(address);

    release();
    await expect(wake).rejects.toThrow(/aborted/);
    await start;

    // Exactly one live session — the deploy's — and the superseded wake
    // must not have torn it down.
    expect(manager.hasSession(address)).toBe(true);
    expect(buildStarts).toEqual([address, address]);
    // Settle any stray teardown microtasks, then re-check the session
    // survived.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(manager.hasSession(address)).toBe(true);
  });

  test("a wake build failure does not destroy the superseding deploy's provisioned entry", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    // Builder: first build (the wake's) is gated and FAILS; later builds
    // succeed (the deploy's session).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let buildCount = 0;
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        buildCount += 1;
        if (buildCount === 1) {
          await gate;
          throw new Error("credential endpoint unreachable");
        }
        return makeBundle();
      },
    };
    const { manager } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
    });
    await manager.restoreSessions();

    // Wake in flight, parked on the gated build.
    const wake = manager.wakeAgent(address);
    await Promise.resolve();
    await Promise.resolve();

    // Fresh deploy for the same address lands while the wake builds:
    // provisionAgent succeeds (the wake's startSessionCore already removed
    // its own provisioned entry) and marks the wake superseded.
    await manager.provisionAgent(makeConfig(address));

    // The wake's build now fails.
    release();
    await wake.catch(() => {});

    // The deploy's provisioned entry must survive the failed wake so its
    // session.start can proceed.
    await manager.startSession(address);
    expect(manager.hasSession(address)).toBe(true);
  });

  test("a first-attempt-only caller joining a wake mid-retry settles at the next attempt boundary", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    // Attempt 1 is gated and fails; attempt 2 succeeds. The joiner must
    // observe attempt 1's failure, not wait out the full retry schedule.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let buildCount = 0;
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        buildCount += 1;
        if (buildCount === 1) {
          await gate;
          throw new Error("first attempt boom");
        }
        return makeBundle();
      },
    };
    const { manager } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
    });
    await manager.restoreSessions();

    // Mail-style trigger starts the full wake.
    const wake = manager.wakeAgent(address);
    await Promise.resolve();
    await Promise.resolve();

    // session.start-style joiner arrives while attempt 1 is in flight.
    const joiner = manager.wakeAgent(address, { awaitFirstAttemptOnly: true });

    release();
    // The joiner rejects with attempt 1's error even though the wake as a
    // whole goes on to succeed on attempt 2.
    await expect(joiner).rejects.toThrow("first attempt boom");
    await wake;
    expect(manager.hasSession(address)).toBe(true);
    expect(buildCount).toBe(2);
  });

  test("mail arriving between a superseding deploy and the doomed wake's unwind is delivered", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    // Only the wake's build is gated; the deploy's build runs straight
    // through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        if (first) {
          first = false;
          await gate;
        }
        return makeBundle();
      },
    };
    const { manager, transport } = makeManager(dataDir, builder);
    await manager.restoreSessions();

    // Wake in flight, build gated.
    const wake = manager.wakeAgent(address);
    wake.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // Fresh deploy supersedes the wake.
    await manager.provisionAgent(makeConfig(address));

    // Mail arrives while the doomed wake is still unwinding (waking set).
    manager.deliverInboundMail(address, inboundMessage("m2", address));

    // Doomed wake unwinds; new deploy's session starts and must inherit
    // the parked message.
    release();
    await manager.startSession(address);
    await Promise.resolve();
    await Promise.resolve();

    const agentTransport = transport.getTransportFor(address);
    const refs = await agentTransport.search("INBOX", {});
    expect(refs.length).toBe(1);
  });

  test("a mail-triggered wake that exhausts its retries surfaces an observable delivery failure", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        throw new Error("credential endpoint unreachable");
      },
    };
    const failures: { agentAddress: string; parkedCount: number }[] = [];
    const { manager, transport } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
      onMailDeliveryFailed: (agentAddress, info) => {
        failures.push({ agentAddress, parkedCount: info.parkedCount });
      },
    });
    await manager.restoreSessions();

    manager.deliverInboundMail(address, inboundMessage("m1", address));

    // Let the wake exhaust its bounded retries.
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // The terminal wake failure is observable, not silent, and names the
    // still-parked message.
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]).toEqual({ agentAddress: address, parkedCount: 1 });

    // The message was not delivered: the wake never built a harness, so no
    // live session exists and the transport was never registered for the
    // address. The message is retained (parked) for a later trigger rather
    // than dropped.
    expect(manager.hasSession(address)).toBe(false);
    expect(() => transport.getTransportFor(address)).toThrow(/not registered/);
  });

  test("a parked message retained after a failed wake is delivered by a later successful wake", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    let fail = true;
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        if (fail) throw new Error("credential endpoint unreachable");
        return makeBundle();
      },
    };
    const failures: string[] = [];
    const { manager, transport } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
      onMailDeliveryFailed: (agentAddress) => {
        failures.push(agentAddress);
      },
    });
    await manager.restoreSessions();

    manager.deliverInboundMail(address, inboundMessage("m1", address));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(failures.length).toBeGreaterThanOrEqual(1);

    // Recovery: the transient build condition clears. A later trigger drains
    // the still-parked message into the freshly built harness.
    fail = false;
    manager.deliverInboundMail(address, inboundMessage("m2", address));
    for (let i = 0; i < 40; i++) await Promise.resolve();

    expect(manager.hasSession(address)).toBe(true);
    const refs = await transport.getTransportFor(address).search("INBOX", {});
    expect(refs.length).toBe(2);
  });

  test("a wake aborted by a destroy is not reported as a mail delivery failure", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        await gate;
        return makeBundle();
      },
    };
    const failures: string[] = [];
    const { manager } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
      onMailDeliveryFailed: (agentAddress) => {
        failures.push(agentAddress);
      },
    });
    await manager.restoreSessions();

    manager.deliverInboundMail(address, inboundMessage("m1", address));
    await Promise.resolve();
    await Promise.resolve();

    // Destroy the agent mid-build: the wake aborts (agent is gone, not a
    // transient failure), so no delivery-failure signal is emitted.
    await manager.destroySession(address);
    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(failures).toEqual([]);
  });

  test("a wake aborted by a supersede with mail re-parked does not report a delivery failure", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    await seedAgentsOnDisk(dataDir, [address]);

    // Only the wake's build is gated so the supersede can land while the
    // wake is in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        if (first) {
          first = false;
          await gate;
        }
        return makeBundle();
      },
    };
    const failures: string[] = [];
    const { manager } = makeManager(dataDir, builder, {
      sleep: () => Promise.resolve(),
      onMailDeliveryFailed: (agentAddress) => {
        failures.push(agentAddress);
      },
    });
    await manager.restoreSessions();

    // Mail triggers a wake; its build is gated.
    manager.deliverInboundMail(address, inboundMessage("m1", address));
    await Promise.resolve();
    await Promise.resolve();

    // A fresh deploy supersedes the wake: it clears the parked batch and
    // marks the in-flight wake token superseded.
    await manager.provisionAgent(makeConfig(address));

    // A second message re-parks against the still-in-flight (now doomed)
    // wake, so the batch is non-empty when the wake aborts. This is the only
    // interleaving where the WakeAbortedError guard is load-bearing: the
    // abort must not be reported as a delivery failure even though mail is
    // parked, because the superseding deploy owns delivery now.
    manager.deliverInboundMail(address, inboundMessage("m2", address));

    release();
    for (let i = 0; i < 40; i++) await Promise.resolve();

    expect(failures).toEqual([]);
  });

  test("mail parked mid-eviction whose post-eviction replay wake fails terminally surfaces a delivery failure", async () => {
    const dataDir = await tempDir();
    const address = "a@local";
    const { repoStore, keyStore } = makeStores(dataDir);
    const transport = createInMemoryTransport();

    let clock = 1_000_000;
    let buildCount = 0;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const builder: HarnessBuilder = {
      canBuildSource() {
        /* accept every source */
      },
      async build() {
        buildCount += 1;
        if (buildCount === 1) {
          // The live session's teardown is gated on close so mail can be
          // parked while the eviction is in flight.
          const bundle = makeBundle();
          bundle.harness = {
            ...bundle.harness,
            close: async () => {
              await closeGate;
            },
          } as unknown as Harness;
          return bundle;
        }
        // The post-eviction replay wake fails terminally.
        throw new Error("credential endpoint unreachable");
      },
    };

    const failures: { agentAddress: string; parkedCount: number }[] = [];
    const manager = createSessionManager({
      transport,
      repoStore,
      keyStore,
      buildHarness: builder,
      createAgentCrypto: (kp) => makeCrypto(kp),
      onEvent: () => {},
      onConnectorStateChanged: () => {},
      now: () => clock,
      idleEvictMs: 60_000,
      sleep: () => Promise.resolve(),
      onMailDeliveryFailed: (agentAddress, info) => {
        failures.push({ agentAddress, parkedCount: info.parkedCount });
      },
    });

    await manager.provisionAgent(makeConfig(address));
    await manager.startSession(address);

    clock += 60_001;
    const eviction = manager.evictIdleSessions();
    // Let the sweep reach the gated harness close so `evicting` is set.
    await Promise.resolve();
    await Promise.resolve();

    // Mail arriving mid-eviction parks against the in-flight teardown.
    manager.deliverInboundMail(address, inboundMessage("m1", address));

    releaseClose();
    await eviction;

    // Let the post-eviction replay wake exhaust its bounded retries.
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // The terminal replay-wake failure is observable, not silent, and names
    // the still-parked message — the same guarantee the deliverInboundMail
    // path already provides.
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]).toEqual({ agentAddress: address, parkedCount: 1 });
    expect(manager.hasSession(address)).toBe(false);
  });
});
