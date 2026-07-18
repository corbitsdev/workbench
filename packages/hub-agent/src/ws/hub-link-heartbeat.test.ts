import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import {
  createSidecarRouter,
  type SidecarAuthenticator,
  type SidecarRouter,
  type WsHandle,
} from "@intx/hub-sessions";

const acceptAnySidecar: SidecarAuthenticator = async ({ sidecarId }) => ({
  kind: "sidecar",
  sidecarId,
});
import { createInMemoryTransport } from "@intx/mail-memory";
import { signEd25519, verifySSHSignature } from "@intx/crypto";
import type { HarnessConfig, KeyPair } from "@intx/types/runtime";
import { hexDecode } from "@intx/types";

import { createHubLink, type DeployRouter } from "./hub-link";
import type { AgentKeyStore } from "../agent-key-store";
import type { SessionManager } from "../session-manager";

// Focused regression harness for inline heartbeat handling. The helpers below
// mirror the shared ones in `hub-link.test.ts`; this file stays self-contained
// so the fix's regression coverage lives in one place.

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
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

const TEST_CONFIG: HarnessConfig = {
  sessionId: "ses_test-session-1",
  agentId: "agent-1",
  tenantId: "tenant-1",
  principalId: "prin_test-principal-1",
  agentAddress: "agent-1@test.interchange",
  systemPrompt: "You are a test agent",
  tools: [],
  grants: [],
  sources: [
    {
      id: "anthropic:claude-sonnet-4-20250514",
      provider: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-test",
      model: "claude-sonnet-4-20250514",
    },
  ],
  defaultSource: "anthropic:claude-sonnet-4-20250514",
};

type TestEnv = {
  server: ReturnType<typeof Bun.serve>;
  router: SidecarRouter;
};

function startTestServer(): TestEnv {
  const router = createSidecarRouter({
    authenticateSidecar: acceptAnySidecar,
    requestTimeoutMs: 5000,
    hubPublicKey: "a".repeat(64),
  });

  const app = new Hono();
  app.get(
    "/ws",
    upgradeWebSocket((_c) => {
      let handle: WsHandle;
      return {
        onOpen(_evt, ws) {
          handle = {
            send(data: string) {
              ws.send(data);
            },
            close() {
              ws.close();
            },
          };
          router.handleOpen(handle);
        },
        onMessage(evt, _ws) {
          if (typeof evt.data === "string") {
            router.handleMessage(handle, evt.data);
          }
        },
        onClose(_evt, _ws) {
          router.handleClose(handle);
        },
      };
    }),
  );

  const server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: 0,
  });

  return { server, router };
}

describe("hub-link heartbeat", () => {
  test("inbound pong is not starved by an awaited pack-apply on the shared queue", async () => {
    const env = startTestServer();
    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();

    // pingIntervalMs=80 → the sidecar self-closes if no pong is observed
    // within 160ms. The pack-apply handler blocks the shared messageQueue for
    // 700ms — far longer than that window. Before the fix, the queued `pong`
    // is stuck behind this awaited handler, `lastPongAt` goes stale, and the
    // ping timer closes the healthy socket. With inline pong handling the
    // heartbeat survives the block.
    const PING_INTERVAL_MS = 80;
    const BLOCK_MS = 700;
    let packApplyStarted = false;
    let packApplyFinished = false;
    sessions.applyDeployPack = async () => {
      packApplyStarted = true;
      await new Promise((r) => setTimeout(r, BLOCK_MS));
      packApplyFinished = true;
    };

    const client = createHubLink({
      hubURL: `ws://localhost:${env.server.port}/ws`,
      sidecarId: "sc-heartbeat",
      token: "test-token",
      transport,
      sessions,
      ...withTestDeployBindings(),
      pingIntervalMs: PING_INTERVAL_MS,
    });

    client.connect();
    try {
      await waitFor(() =>
        env.router.getConnectedSidecars().includes("sc-heartbeat"),
      );
      await env.router.sendAgentDeploy(
        "agent-1@test.interchange",
        TEST_CONFIG,
      );

      // Let a few real ping/pong round trips establish a fresh lastPongAt.
      await new Promise((r) => setTimeout(r, PING_INTERVAL_MS * 3));

      // Occupy the serial messageQueue with the slow pack-apply. Do not await
      // it: the ack only returns once the handler finishes, and we want to
      // observe heartbeat behavior while the queue is blocked.
      const packDone = env.router
        .sendPack(
          "agent-1@test.interchange",
          new Uint8Array([1, 2, 3]),
          "refs/heads/deploy",
          "a".repeat(40),
        )
        .catch(() => {});

      await waitFor(() => packApplyStarted);

      // Sit through the whole block window plus margin. With a starved
      // heartbeat the sidecar would self-close (>160ms of stale pongs).
      await new Promise((r) => setTimeout(r, BLOCK_MS + PING_INTERVAL_MS * 3));

      expect(packApplyFinished).toBe(true);
      // The connection must survive the pack-apply block: the heartbeat was
      // serviced inline, so the sidecar never self-closed.
      expect(env.router.getConnectedSidecars()).toContain("sc-heartbeat");

      await packDone;
    } finally {
      client.close();
      await waitFor(
        () => !env.router.getConnectedSidecars().includes("sc-heartbeat"),
      );
      await env.server.stop(true);
    }
  });
});
