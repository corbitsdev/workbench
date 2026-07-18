// WORKBENCH-LOCAL (CL-3104) test file.
//
// Pins the hibernate flavor of `agent.undeploy`: a frame whose `reason` is the
// well-known hibernate marker routes to `deployRouter.hibernate` (NOT
// `deployRouter.undeploy`), preserves the agent's on-disk state (no
// `deleteAgentDir`) and its signing key (no `forgetAgent`), and still acks so
// the hub's undeploy machinery drops the address from `getRoutableAddresses`.
// The deployment must then be re-deployable at the same address (the
// signal-driven wake path re-sends `agent.deploy`).

import { describe, test, expect, afterAll } from "bun:test";
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

import {
  createHubLink,
  WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
  type DeployRouter,
} from "./hub-link";
import type { AgentKeyStore } from "../agent-key-store";
import type { SessionManager } from "../session-manager";

function createTestKeyStore(): AgentKeyStore & {
  registerKey(address: string, kp: KeyPair): void;
  hasHubKey(address: string): boolean;
} {
  const agentKeys = new Map<string, KeyPair>();
  const hubKeys = new Map<string, Uint8Array>();
  return {
    registerKey(address, kp) {
      agentKeys.set(address, kp);
    },
    hasHubKey(address) {
      return hubKeys.has(address);
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

function createMockSessionManager(): SessionManager & {
  deletedDirs: string[];
} {
  const mock = {
    deletedDirs: [] as string[],

    initRepo: () => Promise.resolve(),
    applyDeployPack: () => Promise.resolve(),
    applyAssetPack: () => Promise.resolve(),
    createStatePack: () =>
      Promise.resolve({
        pack: new Uint8Array([1, 2, 3]),
        commitSha: "abc123",
        ref: "refs/heads/main",
      }),
    deleteAgentDir: (agentAddress: string) => {
      mock.deletedDirs.push(agentAddress);
      return Promise.resolve();
    },
    getDeployRef: (_agentAddress: string) => Promise.resolve(null),
    getAddresses: () => [],
    getSessionId: (_agentAddress: string) => undefined,
  } satisfies SessionManager & {
    deletedDirs: string[];
  };
  return mock;
}

const TEST_CONFIG: HarnessConfig = {
  sessionId: "ses_test-session-hibernate",
  agentId: "agent-hibernate",
  tenantId: "tenant-hibernate",
  principalId: "prin_hibernate",
  agentAddress: "agent-hibernate@test.interchange",
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

type TestEnv = {
  server: ReturnType<typeof Bun.serve>;
  router: SidecarRouter;
};

function startTestServer(requestTimeoutMs = 5000): TestEnv {
  const router = createSidecarRouter({
    authenticateSidecar: acceptAnySidecar,
    requestTimeoutMs,
    hubPublicKey: "a".repeat(64),
    lookups: {},
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

const env = startTestServer();

afterAll(async () => {
  await env.server.stop(true);
});

describe("hub-link hibernate undeploy flavor", () => {
  test("hibernate reason routes to the hibernate hook, keeps state, acks, and allows a wake re-deploy", async () => {
    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const keyStore = createTestKeyStore();

    const hibernated: string[] = [];
    const undeployed: string[] = [];
    const deployRouter: DeployRouter = {
      async deploy(frame) {
        keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
        return { publicKey: "aa".repeat(32) };
      },
      async undeploy(frame) {
        undeployed.push(frame.agentAddress);
      },
      async hibernate(frame) {
        hibernated.push(frame.agentAddress);
      },
    };

    const client = createHubLink({
      hubURL: `ws://localhost:${env.server.port}/ws`,
      sidecarId: "sc-hibernate",
      token: "test-token",
      transport,
      sessions,
      keyStore,
      deployRouter,
    });

    client.connect();
    try {
      await waitFor(() =>
        env.router.getConnectedSidecars().includes("sc-hibernate"),
      );

      const agentAddress = TEST_CONFIG.agentAddress;
      await env.router.sendAgentDeploy(agentAddress, TEST_CONFIG);
      await waitFor(() =>
        env.router.getRoutableAddresses().includes(agentAddress),
      );
      expect(keyStore.hasHubKey(agentAddress)).toBe(true);

      // Hibernate: the well-known reason selects the state-preserving
      // teardown. The ack must still fire so the hub's undeploy machinery
      // removes the address from the routable set — that unroutability is
      // what makes the next gate signal re-establish the deployment.
      await env.router.sendAgentUndeploy(
        agentAddress,
        WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
      );
      await waitFor(
        () => !env.router.getRoutableAddresses().includes(agentAddress),
      );

      expect(hibernated).toEqual([agentAddress]);
      expect(undeployed).toEqual([]);
      // Durable state preserved: the agent dir was NOT deleted and the
      // recorded hub key was NOT forgotten.
      expect(sessions.deletedDirs).toEqual([]);
      expect(keyStore.hasHubKey(agentAddress)).toBe(true);

      // Wake: a fresh deploy at the same address succeeds (the hub's
      // signal-path re-establishment re-sends agent.deploy).
      await env.router.sendAgentDeploy(agentAddress, TEST_CONFIG);
      await waitFor(() =>
        env.router.getRoutableAddresses().includes(agentAddress),
      );

      // A full (non-hibernate) undeploy still routes to the undeploy hook
      // and deletes the agent dir — the hibernate branch is reason-scoped.
      await env.router.sendAgentUndeploy(agentAddress, "test teardown");
      await waitFor(
        () => !env.router.getRoutableAddresses().includes(agentAddress),
      );
      expect(undeployed).toEqual([agentAddress]);
      expect(sessions.deletedDirs).toEqual([agentAddress]);
    } finally {
      client.close();
      await waitFor(
        () => !env.router.getConnectedSidecars().includes("sc-hibernate"),
      );
    }
  });

  test("a transient hibernate hook failure is retried once and still acks", async () => {
    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const keyStore = createTestKeyStore();

    let hibernateCalls = 0;
    const deployRouter: DeployRouter = {
      async deploy(frame) {
        keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
        return { publicKey: "aa".repeat(32) };
      },
      async hibernate() {
        hibernateCalls += 1;
        if (hibernateCalls === 1) throw new Error("transient teardown race");
      },
    };

    const client = createHubLink({
      hubURL: `ws://localhost:${env.server.port}/ws`,
      sidecarId: "sc-hibernate-retry",
      token: "test-token",
      transport,
      sessions,
      keyStore,
      deployRouter,
    });

    client.connect();
    try {
      await waitFor(() =>
        env.router.getConnectedSidecars().includes("sc-hibernate-retry"),
      );
      const agentAddress = "agent-hibernate-retry@test.interchange";
      await env.router.sendAgentDeploy(agentAddress, {
        ...TEST_CONFIG,
        agentAddress,
        sessionId: "ses_test-hibernate-retry",
      });
      await waitFor(() =>
        env.router.getRoutableAddresses().includes(agentAddress),
      );

      // First hibernate attempt throws; the link retries the idempotent
      // teardown once, the retry succeeds, and the ack fires.
      await env.router.sendAgentUndeploy(
        agentAddress,
        WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
      );
      await waitFor(
        () => !env.router.getRoutableAddresses().includes(agentAddress),
      );
      expect(hibernateCalls).toBe(2);
      expect(sessions.deletedDirs).toEqual([]);
    } finally {
      client.close();
      await waitFor(
        () => !env.router.getConnectedSidecars().includes("sc-hibernate-retry"),
      );
    }
  });
});

describe("hub-link hibernate withholds the ack when it cannot hibernate", () => {
  // Withholding the ack does NOT keep the address routable — interchange's
  // sendAgentUndeploy timeout arm removes the address before rejecting. What
  // the withheld ack buys is a LOUD failure at the hub caller (the reconciler
  // counts it) instead of a silent success, and the sidecar keeps the
  // deployment resident so the wake re-deploy's resident-supervisor guard can
  // recover it. A short-timeout server keeps these tests fast.
  const shortEnv = startTestServer(300);

  afterAll(async () => {
    await shortEnv.server.stop(true);
  });

  test("missing hibernate hook: no ack, no teardown of any kind", async () => {
    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const keyStore = createTestKeyStore();

    const undeployed: string[] = [];
    const deployRouter: DeployRouter = {
      async deploy(frame) {
        keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
        return { publicKey: "aa".repeat(32) };
      },
      async undeploy(frame) {
        undeployed.push(frame.agentAddress);
      },
      // No hibernate hook.
    };

    const client = createHubLink({
      hubURL: `ws://localhost:${shortEnv.server.port}/ws`,
      sidecarId: "sc-no-hook",
      token: "test-token",
      transport,
      sessions,
      keyStore,
      deployRouter,
    });

    client.connect();
    try {
      await waitFor(() =>
        shortEnv.router.getConnectedSidecars().includes("sc-no-hook"),
      );
      const agentAddress = "agent-no-hook@test.interchange";
      await shortEnv.router.sendAgentDeploy(agentAddress, {
        ...TEST_CONFIG,
        agentAddress,
        sessionId: "ses_test-no-hook",
      });
      await waitFor(() =>
        shortEnv.router.getRoutableAddresses().includes(agentAddress),
      );

      // No ack is sent, so the hub-side undeploy times out (rejects) —
      // the failure is loud, never a silent fake success.
      await expect(
        shortEnv.router.sendAgentUndeploy(
          agentAddress,
          WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
        ),
      ).rejects.toThrow();
      // The deployment stays fully resident on the sidecar: neither the
      // undeploy hook nor any state deletion ran.
      expect(undeployed).toEqual([]);
      expect(sessions.deletedDirs).toEqual([]);
    } finally {
      client.close();
      await waitFor(
        () => !shortEnv.router.getConnectedSidecars().includes("sc-no-hook"),
      );
    }
  });

  test("hibernate hook failing twice: retried once, then no ack and the deployment stays resident", async () => {
    const transport = createInMemoryTransport();
    const sessions = createMockSessionManager();
    const keyStore = createTestKeyStore();

    let hibernateCalls = 0;
    const deployRouter: DeployRouter = {
      async deploy(frame) {
        keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
        return { publicKey: "aa".repeat(32) };
      },
      async hibernate() {
        hibernateCalls += 1;
        throw new Error("teardown keeps failing");
      },
    };

    const client = createHubLink({
      hubURL: `ws://localhost:${shortEnv.server.port}/ws`,
      sidecarId: "sc-hook-fails",
      token: "test-token",
      transport,
      sessions,
      keyStore,
      deployRouter,
    });

    client.connect();
    try {
      await waitFor(() =>
        shortEnv.router.getConnectedSidecars().includes("sc-hook-fails"),
      );
      const agentAddress = "agent-hook-fails@test.interchange";
      await shortEnv.router.sendAgentDeploy(agentAddress, {
        ...TEST_CONFIG,
        agentAddress,
        sessionId: "ses_test-hook-fails",
      });
      await waitFor(() =>
        shortEnv.router.getRoutableAddresses().includes(agentAddress),
      );

      await expect(
        shortEnv.router.sendAgentUndeploy(
          agentAddress,
          WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
        ),
      ).rejects.toThrow();
      expect(hibernateCalls).toBe(2);
      expect(sessions.deletedDirs).toEqual([]);
    } finally {
      client.close();
      await waitFor(
        () => !shortEnv.router.getConnectedSidecars().includes("sc-hook-fails"),
      );
    }
  });
});
