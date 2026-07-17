import { describe, test, expect } from "bun:test";
import { createInMemoryTransport } from "@intx/mail-memory";
import { signEd25519, verifySSHSignature } from "@intx/crypto";
import type {
  HarnessConfig,
  InboundMessage,
  InferenceSource,
  KeyPair,
} from "@intx/types/runtime";
import type { GrantRule } from "@intx/types/authz";
import { hexDecode } from "@intx/types";

import {
  createHubLink,
  type DeployRouter,
  type ReconnectScheduler,
} from "./hub-link";
import type { AgentKeyStore } from "../agent-key-store";
import type { AgentEventListener, SessionManager } from "../session-manager";
import { NoActiveTurnError } from "../session-manager";

// Fake global WebSocket so the connect-timeout timer can be driven
// deterministically -- no real network, no wall-clock waits. Every
// instance is recorded so the test can reach in and fire `open`/`close`
// on demand. `bun test --isolate` gives this file a fresh global, so
// overriding `WebSocket` here does not leak into other test files.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  send(_data: string): void {}

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "" });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  private dispatch(type: string, detail: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(detail);
  }
}

(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;

// Helpers below mirror `hub-link-heartbeat.test.ts` (mock SessionManager,
// AgentKeyStore, and DeployRouter); this file stays self-contained so the
// connect-timeout regression coverage lives in one place.

function createTestKeyStore(): AgentKeyStore & {
  registerKey(address: string, kp: KeyPair): void;
} {
  const agentKeys = new Map<string, KeyPair>();
  const hubKeys = new Map<string, Uint8Array>();
  return {
    registerKey(address, kp) {
      agentKeys.set(address, kp);
    },
    async loadOrGenerateKey(address) {
      const existing = agentKeys.get(address);
      if (existing !== undefined) return { keyPair: existing, isNew: false };
      throw new Error(`No key registered for ${address} in test store`);
    },
    async scanKeys() {
      return [...agentKeys.entries()].map(([address, keyPair]) => ({
        address,
        keyPair,
      }));
    },
    async signChallenge(address, payload) {
      const kp = agentKeys.get(address);
      if (kp === undefined) return null;
      return await signEd25519(kp.privateKey, payload);
    },
    recordHubKey(address, hexHubPublicKey) {
      hubKeys.set(address, hexDecode(hexHubPublicKey));
    },
    verifyDeployCommit(address, payload, signature) {
      const hubKey = hubKeys.get(address);
      if (hubKey === undefined) {
        throw new Error(
          `signature_invalid: no hub public key for "${address}"`,
        );
      }
      return verifySSHSignature(payload, signature, hubKey);
    },
    forgetAgent(address) {
      agentKeys.delete(address);
      hubKeys.delete(address);
    },
  };
}

function createTestDeployRouter(
  sessions: SessionManager,
  keyStore: AgentKeyStore,
): DeployRouter {
  return {
    async deploy(frame) {
      const result = await sessions.provisionAgent(frame.config);
      keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
      await sessions.persistHubPublicKey(
        frame.agentAddress,
        frame.hubPublicKey,
      );
      return { publicKey: result.publicKey };
    },
  };
}

function withTestDeployBindings(sessions: SessionManager): {
  keyStore: AgentKeyStore & { registerKey(address: string, kp: KeyPair): void };
  deployRouter: DeployRouter;
} {
  const keyStore = createTestKeyStore();
  return {
    keyStore,
    deployRouter: createTestDeployRouter(sessions, keyStore),
  };
}

type DeliveredMessage = { agentAddress: string; message: InboundMessage };

function createMockSessionManager(): SessionManager & {
  provisionedAddresses: string[];
} {
  const mock = {
    provisioned: [] as HarnessConfig[],
    delivered: [] as DeliveredMessage[],
    inboundMail: [] as { agentAddress: string; rawMessage: Uint8Array }[],
    addresses: [] as string[],
    provisionedAddresses: [] as string[],

    async provisionAgent(config: HarnessConfig) {
      mock.provisioned.push(config);
      mock.provisionedAddresses.push(config.agentAddress);
      return {
        publicKey: "deadbeef",
        keyPair: {
          publicKey: new Uint8Array(32),
          privateKey: new Uint8Array(32),
        },
      };
    },
    async startSession(agentAddress: string): Promise<void> {
      mock.provisionedAddresses = mock.provisionedAddresses.filter(
        (a) => a !== agentAddress,
      );
      mock.addresses.push(agentAddress);
    },
    async destroySession(agentAddress: string): Promise<void> {
      mock.addresses = mock.addresses.filter((a) => a !== agentAddress);
    },
    async abortSession(agentAddress: string): Promise<void> {
      mock.addresses = mock.addresses.filter((a) => a !== agentAddress);
    },
    async abortTurn(agentAddress: string): Promise<void> {
      throw new NoActiveTurnError(agentAddress);
    },
    deliverMessage(agentAddress: string, message: InboundMessage): void {
      mock.delivered.push({ agentAddress, message });
    },
    isWakeable(): boolean {
      return false;
    },
    evictIdleSessions: () => Promise.resolve(),
    async wakeAgent(agentAddress: string): Promise<void> {
      if (!mock.addresses.includes(agentAddress)) {
        mock.addresses.push(agentAddress);
      }
    },
    deliverInboundMail(agentAddress: string, rawMessage: Uint8Array): void {
      mock.inboundMail.push({ agentAddress, rawMessage });
    },
    async updateGrants(
      _agentAddress: string,
      _grants: GrantRule[],
    ): Promise<void> {},
    async updateSources(
      _agentAddress: string,
      _sources: InferenceSource[],
      _defaultSource: string,
    ): Promise<void> {},
    hasSession(agentAddress: string): boolean {
      return mock.addresses.includes(agentAddress);
    },
    isProvisioned(agentAddress: string): boolean {
      return mock.provisionedAddresses.includes(agentAddress);
    },
    getAddresses(): string[] {
      return [...mock.addresses];
    },
    async restoreSessions() {
      return { restored: [], failed: [] };
    },
    applyDeployPack: () => Promise.resolve(),
    applyAssetPack: () => Promise.resolve(),
    createStatePack: () =>
      Promise.resolve({
        pack: new Uint8Array([1, 2, 3]),
        commitSha: "abc123",
        ref: "refs/heads/main",
      }),
    deleteAgentDir: () => Promise.resolve(),
    getDeployRef: (_agentAddress: string) => Promise.resolve(null),
    persistHubPublicKey: (_agentAddress: string, _hubPublicKey: string) =>
      Promise.resolve(),
    commitInboundMail: (_agentAddress: string, _rawMessage: Uint8Array) =>
      Promise.resolve(),
    getSessionId: (_agentAddress: string) => undefined,
    onAgentEvent:
      (_agentAddress: string, _listener: AgentEventListener) => () => {},
  };
  return mock;
}

describe("hub-link connect timeout", () => {
  test("closes the socket and schedules a reconnect when a connect attempt never opens", () => {
    FakeWebSocket.instances = [];
    let timeoutCallback: (() => void) | null = null;
    let capturedDelay: number | null = null;
    const fakeScheduleConnectTimeout: ReconnectScheduler = (cb, delayMs) => {
      timeoutCallback = cb;
      capturedDelay = delayMs;
      return () => {
        timeoutCallback = null;
      };
    };

    let pendingReconnect: (() => void) | null = null;
    const fakeScheduleReconnect: ReconnectScheduler = (cb) => {
      pendingReconnect = cb;
      return () => {
        pendingReconnect = null;
      };
    };

    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const client = createHubLink({
      hubURL: "ws://hub.invalid/ws",
      sidecarId: "sc-connect-timeout",
      token: "test-token",
      transport,
      sessions,
      ...withTestDeployBindings(sessions),
      connectTimeoutMs: 1234,
      scheduleConnectTimeout: fakeScheduleConnectTimeout,
      scheduleReconnect: fakeScheduleReconnect,
    });

    try {
      client.connect();

      expect(FakeWebSocket.instances).toHaveLength(1);
      const socket = FakeWebSocket.instances[0]!;
      expect(capturedDelay).toBe(1234);
      expect(socket.readyState).not.toBe(FakeWebSocket.CLOSED);

      // The `open` event never fires -- simulate the timer expiring.
      expect(timeoutCallback).not.toBeNull();
      timeoutCallback!();

      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      // The socket's own `close` handler must have run scheduleReconnectOnce.
      expect(pendingReconnect).not.toBeNull();
    } finally {
      client.close();
    }
  });

  test("clears the connect timeout once the socket opens, without a spurious close", () => {
    FakeWebSocket.instances = [];
    let timeoutCallback: (() => void) | null = null;
    const fakeScheduleConnectTimeout: ReconnectScheduler = (cb) => {
      timeoutCallback = cb;
      return () => {
        timeoutCallback = null;
      };
    };

    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const client = createHubLink({
      hubURL: "ws://hub.invalid/ws",
      sidecarId: "sc-connect-timeout-open",
      token: "test-token",
      transport,
      sessions,
      ...withTestDeployBindings(sessions),
      connectTimeoutMs: 1234,
      scheduleConnectTimeout: fakeScheduleConnectTimeout,
    });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0]!;
      expect(timeoutCallback).not.toBeNull();

      socket.open();

      // Opening must cancel the connect timeout via the scheduler's own
      // cancel function -- the fake sets the captured callback back to
      // null when that happens.
      expect(timeoutCallback).toBeNull();
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    } finally {
      client.close();
    }
  });
});
