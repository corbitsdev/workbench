import { describe, test, expect } from "bun:test";
import { createInMemoryTransport } from "@intx/mail-memory";
import { signEd25519, verifySSHSignature } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import { hexDecode } from "@intx/types";

import {
  createHubLink,
  type DeployRouter,
  type ReconnectScheduler,
} from "./hub-link";
import type { AgentKeyStore } from "../agent-key-store";
import type { SessionManager } from "../session-manager";

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

function createTestDeployRouter(keyStore: AgentKeyStore): DeployRouter {
  return {
    async deploy(frame) {
      keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
      return { publicKey: "aa".repeat(32) };
    },
  };
}

function withTestDeployBindings(): {
  keyStore: AgentKeyStore & { registerKey(address: string, kp: KeyPair): void };
  deployRouter: DeployRouter;
} {
  const keyStore = createTestKeyStore();
  return {
    keyStore,
    deployRouter: createTestDeployRouter(keyStore),
  };
}

function createMockSessionManager(): SessionManager {
  return {
    initRepo: () => Promise.resolve(),
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
    getAddresses: () => [],
    getSessionId: (_agentAddress: string) => undefined,
  };
}

describe("hub-link connect timeout", () => {
  test("closes the socket and schedules a reconnect when a connect attempt never opens", () => {
    FakeWebSocket.instances = [];
    let timeoutCallback: (() => void) | null = null;
    // Object capture: a plain `let` would be control-flow-narrowed to null
    // at the assertion site (the assignment happens inside the callback).
    const captured: { delayMs?: number } = {};
    const fakeScheduleConnectTimeout: ReconnectScheduler = (cb, delayMs) => {
      timeoutCallback = cb;
      captured.delayMs = delayMs;
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
      ...withTestDeployBindings(),
      connectTimeoutMs: 1234,
      scheduleConnectTimeout: fakeScheduleConnectTimeout,
      scheduleReconnect: fakeScheduleReconnect,
    });

    try {
      client.connect();

      expect(FakeWebSocket.instances).toHaveLength(1);
      const socket = FakeWebSocket.instances[0]!;
      expect(captured.delayMs).toBe(1234);
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
      ...withTestDeployBindings(),
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

  test("close() during a pending connect attempt cancels the connect timeout", () => {
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
      sidecarId: "sc-connect-timeout-close",
      token: "test-token",
      transport,
      sessions,
      ...withTestDeployBindings(),
      connectTimeoutMs: 1234,
      scheduleConnectTimeout: fakeScheduleConnectTimeout,
    });

    client.connect();
    expect(timeoutCallback).not.toBeNull();

    client.close();

    // close() must disarm the pending attempt's timer itself, not leave it
    // to fire later and rely on the no-op guard.
    expect(timeoutCallback).toBeNull();
  });

  test("a stale timer from a superseded attempt never closes the current socket", () => {
    FakeWebSocket.instances = [];
    const timeoutCallbacks: (() => void)[] = [];
    const fakeScheduleConnectTimeout: ReconnectScheduler = (cb) => {
      timeoutCallbacks.push(cb);
      return () => {};
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
      sidecarId: "sc-connect-timeout-stale",
      token: "test-token",
      transport,
      sessions,
      ...withTestDeployBindings(),
      connectTimeoutMs: 1234,
      scheduleConnectTimeout: fakeScheduleConnectTimeout,
      scheduleReconnect: fakeScheduleReconnect,
    });

    try {
      client.connect();
      const first = FakeWebSocket.instances[0]!;

      // First attempt times out; its close handler schedules a reconnect,
      // which starts the second attempt.
      timeoutCallbacks[0]!();
      expect(first.readyState).toBe(FakeWebSocket.CLOSED);
      expect(pendingReconnect).not.toBeNull();
      pendingReconnect!();

      const second = FakeWebSocket.instances[1]!;
      second.open();

      // Firing the first attempt's timer again must not touch the second,
      // now-open socket: the closure is bound to its own (closed) socket.
      timeoutCallbacks[0]!();
      expect(second.readyState).toBe(FakeWebSocket.OPEN);
    } finally {
      client.close();
    }
  });
});
