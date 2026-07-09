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
  type SidecarRouter,
  type WsHandle,
} from "@intx/hub-sessions";
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
  WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
  type DeployRouter,
} from "./hub-link";
import type { AgentKeyStore } from "../agent-key-store";
import type { AgentEventListener, SessionManager } from "../session-manager";

function createTestKeyStore(): AgentKeyStore & {
  registerKey(address: string, kp: KeyPair): void;
  hasKey(address: string): boolean;
} {
  const agentKeys = new Map<string, KeyPair>();
  const hubKeys = new Map<string, Uint8Array>();
  return {
    registerKey(address, kp) {
      agentKeys.set(address, kp);
    },
    hasKey(address) {
      return agentKeys.has(address);
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

function createMockSessionManager(): SessionManager & {
  provisioned: HarnessConfig[];
  addresses: string[];
  destroyed: string[];
  deletedDirs: string[];
} {
  const mock = {
    provisioned: [] as HarnessConfig[],
    addresses: [] as string[],
    destroyed: [] as string[],
    deletedDirs: [] as string[],

    async provisionAgent(config: HarnessConfig) {
      mock.provisioned.push(config);
      mock.addresses.push(config.agentAddress);
      return {
        publicKey: "deadbeef",
        keyPair: {
          publicKey: new Uint8Array(32),
          privateKey: new Uint8Array(32),
        },
      };
    },
    async startSession(_agentAddress: string): Promise<void> {
      /* unused */
    },
    async destroySession(agentAddress: string): Promise<void> {
      mock.destroyed.push(agentAddress);
      mock.addresses = mock.addresses.filter((a) => a !== agentAddress);
    },
    async abortSession(_agentAddress: string, _reason: string): Promise<void> {
      /* unused */
    },
    deliverMessage(_agentAddress: string, _message: InboundMessage): void {
      /* unused */
    },
    async updateGrants(
      _agentAddress: string,
      _grants: GrantRule[],
    ): Promise<void> {
      /* unused */
    },
    async updateSources(
      _agentAddress: string,
      _sources: InferenceSource[],
      _defaultSource: string,
    ): Promise<void> {
      /* unused */
    },
    hasSession(agentAddress: string): boolean {
      return mock.addresses.includes(agentAddress);
    },
    isProvisioned(agentAddress: string): boolean {
      return mock.addresses.includes(agentAddress);
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
    deleteAgentDir: (agentAddress: string) => {
      mock.deletedDirs.push(agentAddress);
      return Promise.resolve();
    },
    getDeployRef: (_agentAddress: string) => Promise.resolve(null),
    persistHubPublicKey: (_agentAddress: string, _hubPublicKey: string) =>
      Promise.resolve(),
    commitInboundMail: (_agentAddress: string, _rawMessage: Uint8Array) =>
      Promise.resolve(),
    getSessionId: (_agentAddress: string) => undefined,
    onAgentEvent:
      (_agentAddress: string, _listener: AgentEventListener) => () => {
        /* unused */
      },
  } satisfies SessionManager & {
    provisioned: HarnessConfig[];
    addresses: string[];
    destroyed: string[];
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

function startTestServer(): TestEnv {
  const router = createSidecarRouter({
    requestTimeoutMs: 5000,
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
        const result = await sessions.provisionAgent(frame.config);
        keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
        await sessions.persistHubPublicKey(
          frame.agentAddress,
          frame.hubPublicKey,
        );
        return { publicKey: result.publicKey };
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
      expect(keyStore.hasKey(agentAddress)).toBe(true);

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
      // signing key was NOT forgotten.
      expect(sessions.deletedDirs).toEqual([]);
      expect(keyStore.hasKey(agentAddress)).toBe(true);

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
});
