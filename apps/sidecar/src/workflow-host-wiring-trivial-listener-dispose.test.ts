// WORKBENCH-LOCAL (CL-3780): a torn trivial deploy must dispose the
// `onAgentEvent` run-chain listener it attached.
//
// The trivial branch subscribes to the agent's InferenceEvents inside
// `trivialLaunch` (via `deps.onAgentEvent`) to project the reactor's
// run-bracket vocabulary onto the workflow-run event chain. That listener
// lives on `SessionManager`'s `agentEventListeners` set, which
// `destroySession` does NOT prune. If a deploy fails AFTER `trivialLaunch`
// has provisioned a live harness and attached the listener, the earlier code
// unwound the registry mapping but left the listener behind. A later
// inference event then fired the orphaned listener, whose `recordRunEvent`
// resolves the (now-unregistered) deployment address to `null` and throws
// "no agent address registered for deployment" on every push — dropping the
// run events (including a tool call's result) forever.
//
// This drives the torn-deploy path by having `provisionAgent` surface an
// `undefined` public key: `trivialLaunch` completes (so the listener IS
// attached), `supervisor.deploy` resolves, and the router's post-deploy
// public-key check throws — the failure lands in the trivial `finally` AFTER
// the listener exists. The test asserts the listener was disposed (so no
// orphaned listener survives to hit the null-address resolve) and the
// provisioned harness was torn down.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";

import { describe, test, expect } from "bun:test";
import { createInMemoryTransport } from "@intx/mail-memory";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import type { RepoId, RepoStore } from "@intx/hub-sessions";
import type { AgentDeployFrame } from "@intx/types/sidecar";

import {
  createDeploymentAddressRegistry,
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
} from "./workflow-run-pack-client";
import {
  createSidecarDeployRouter,
  deriveTrivialDeploymentId,
} from "./workflow-host-wiring";

function stubKeyStore(): Parameters<
  typeof createSidecarDeployRouter
>[0]["keyStore"] {
  return {
    async loadOrGenerateKey() {
      return { keyPair: await generateKeyPair(), isNew: false };
    },
    async scanKeys() {
      return [];
    },
    signChallenge() {
      return null;
    },
    recordHubKey() {
      /* no-op */
    },
    verifyDeployCommit() {
      return true;
    },
    forgetAgent() {
      /* no-op */
    },
  } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["keyStore"];
}

// A `SessionManager` stub whose `provisionAgent` succeeds but surfaces an
// `undefined` public key — the router's post-`deploy` check then throws,
// producing a torn deploy AFTER `trivialLaunch` attached the listener.
// `destroySession` is a spy so the test can assert the harness cleanup fires.
function stubTornDeploySessions(spies: {
  destroyed: string[];
}): Parameters<typeof createSidecarDeployRouter>[0]["sessions"] {
  return {
    async provisionAgent() {
      return { publicKey: undefined };
    },
    recordHubKey() {
      /* no-op */
    },
    async persistHubPublicKey() {
      /* no-op */
    },
    async destroySession(agentAddress: string) {
      spies.destroyed.push(agentAddress);
    },
  } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["sessions"];
}

// A `SessionManager` stub whose `provisionAgent` succeeds with a real public
// key so `router.deploy` reaches the success path (listener attached, no
// torn-`finally` unwind). Used to exercise the `teardownDeployment` disposal
// and same-address redeploy paths.
function stubSuccessSessions(spies: {
  destroyed: string[];
}): Parameters<typeof createSidecarDeployRouter>[0]["sessions"] {
  return {
    async provisionAgent() {
      return { publicKey: "aa".repeat(32) };
    },
    recordHubKey() {
      /* no-op */
    },
    async persistHubPublicKey() {
      /* no-op */
    },
    async destroySession(agentAddress: string) {
      spies.destroyed.push(agentAddress);
    },
  } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["sessions"];
}

// Mirrors `SessionManager.onAgentEvent`: a per-address listener set whose
// disposer removes the listener and prunes the empty set. The test inspects
// the set to prove the orphaned listener is gone after the torn deploy.
function makeListenerTrackingOnAgentEvent() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const onAgentEvent = (
    agentAddress: string,
    listener: (event: unknown) => void,
  ): (() => void) => {
    let set = listeners.get(agentAddress);
    if (set === undefined) {
      set = new Set();
      listeners.set(agentAddress, set);
    }
    set.add(listener);
    return () => {
      const current = listeners.get(agentAddress);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(agentAddress);
    };
  };
  return { listeners, onAgentEvent };
}

function makeRepoStoreStub(tmpDir: string): RepoStore {
  return {
    getRepoDir(repoId: RepoId): string {
      return pathJoin(tmpDir, repoId.kind, repoId.id);
    },
    writeTree(_p, repoId, _ref, content) {
      const dir = pathJoin(tmpDir, repoId.kind, repoId.id);
      for (const [relPath, contents] of Object.entries(content.files)) {
        const full = pathJoin(dir, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
      }
      return Promise.resolve({ commitSha: "stub-sha", newlyTerminalRuns: [] });
    },
    writeTreePreservingPrefix(_p, _repoId, _ref, _args) {
      return Promise.resolve({ commitSha: "stub-sha", newlyTerminalRuns: [] });
    },
    resolveRef() {
      return Promise.resolve(null);
    },
    listRefs() {
      return Promise.resolve([]);
    },
    resolveHead() {
      return Promise.resolve(null);
    },
    initRepo() {
      return Promise.resolve();
    },
    receivePack() {
      return Promise.resolve({ commitSha: "stub-sha", newlyTerminalRuns: [] });
    },
    createPack() {
      return Promise.resolve({ pack: new Uint8Array(), commitSha: "stub-sha" });
    },
    subscribe() {
      return () => undefined;
    },
  } as unknown as RepoStore;
}

describe("trivial deploy torn-unwind listener disposal (CL-3780)", () => {
  test("a deploy that fails after trivialLaunch disposes the run-chain listener and tears the harness down", async () => {
    const registry = createDeploymentAddressRegistry();
    const mailRouter = createMultistepMailRouter();
    const signalRouter = createMultistepSignalRouter();
    const drainRouter = createMultistepDrainRouter();
    const transport = createInMemoryTransport();
    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "cl-3780-listener-"));

    const agentAddress = "ins_listener@x.example";
    const slug = deriveTrivialDeploymentId(agentAddress);

    const spies = { destroyed: [] as string[] };
    const { listeners, onAgentEvent } = makeListenerTrackingOnAgentEvent();

    const router = createSidecarDeployRouter({
      sessions: stubTornDeploySessions(spies),
      keyStore: stubKeyStore(),
      onAgentEvent,
      transport,
      repoStore: makeRepoStoreStub(tmpDir),
      signingKeySeed: new Uint8Array(32),
      createAgentCrypto: createEd25519Crypto,
      registerDeployment: ({ deploymentId, agentAddress: addr }) => {
        registry.record(deploymentId, addr);
      },
      unregisterDeployment: ({ deploymentId }) => {
        registry.unregister(deploymentId);
      },
      multistepMailRouter: mailRouter,
      multistepSignalRouter: signalRouter,
      multistepDrainRouter: drainRouter,
    });

    const frame: AgentDeployFrame = {
      type: "agent.deploy",
      agentAddress,
      agentId: "ins_listener",
      hubPublicKey: "00".repeat(32),
      config: {
        agentAddress,
        agentId: "ins_listener",
        sessionId: "session-listener",
        sources: [],
        defaultSource: "primary",
        grants: [],
      } as unknown as AgentDeployFrame["config"],
    };

    let threw = false;
    try {
      await router.deploy(frame);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The torn deploy disposed the run-chain listener: no orphaned listener
    // survives on the agent's `agentEventListeners` set to fire against the
    // unregistered deployment.
    expect(listeners.get(agentAddress)).toBeUndefined();

    // The provisioned harness was torn down as part of the unwind.
    expect(spies.destroyed).toContain(agentAddress);

    // The registry mapping is clean (existing H-A1/CL-2400 invariant).
    expect(registry.resolve(slug)).toBeNull();
  });

  test("undeploy of a successful trivial deploy disposes the run-chain listener", async () => {
    const registry = createDeploymentAddressRegistry();
    const transport = createInMemoryTransport();
    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "cl-3780-undeploy-"));
    const agentAddress = "ins_undeploy@x.example";

    const spies = { destroyed: [] as string[] };
    const { listeners, onAgentEvent } = makeListenerTrackingOnAgentEvent();

    const router = createSidecarDeployRouter({
      sessions: stubSuccessSessions(spies),
      keyStore: stubKeyStore(),
      onAgentEvent,
      transport,
      repoStore: makeRepoStoreStub(tmpDir),
      signingKeySeed: new Uint8Array(32),
      createAgentCrypto: createEd25519Crypto,
      registerDeployment: ({ deploymentId, agentAddress: addr }) => {
        registry.record(deploymentId, addr);
      },
      unregisterDeployment: ({ deploymentId }) => {
        registry.unregister(deploymentId);
      },
      multistepMailRouter: createMultistepMailRouter(),
      multistepSignalRouter: createMultistepSignalRouter(),
      multistepDrainRouter: createMultistepDrainRouter(),
    });

    const frame: AgentDeployFrame = {
      type: "agent.deploy",
      agentAddress,
      agentId: "ins_undeploy",
      hubPublicKey: "00".repeat(32),
      config: {
        agentAddress,
        agentId: "ins_undeploy",
        sessionId: "session-undeploy",
        sources: [],
        defaultSource: "primary",
        grants: [],
      } as unknown as AgentDeployFrame["config"],
    };

    await router.deploy(frame);
    // The successful deploy attached exactly one run-chain listener.
    expect(listeners.get(agentAddress)?.size).toBe(1);

    await router.undeploy?.({
      type: "agent.undeploy",
      agentAddress,
      reason: "test",
    });

    // teardownDeployment disposed the listener — it does not outlive the
    // deployment on `agentEventListeners` (which `destroySession` never prunes).
    expect(listeners.get(agentAddress)).toBeUndefined();
  });

  test("a same-address trivial redeploy disposes the prior listener (no leak, no doubled listener)", async () => {
    const registry = createDeploymentAddressRegistry();
    const transport = createInMemoryTransport();
    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "cl-3780-redeploy-"));
    const agentAddress = "ins_redeploy@x.example";

    const spies = { destroyed: [] as string[] };
    const { listeners, onAgentEvent } = makeListenerTrackingOnAgentEvent();

    const router = createSidecarDeployRouter({
      sessions: stubSuccessSessions(spies),
      keyStore: stubKeyStore(),
      onAgentEvent,
      transport,
      repoStore: makeRepoStoreStub(tmpDir),
      signingKeySeed: new Uint8Array(32),
      createAgentCrypto: createEd25519Crypto,
      registerDeployment: ({ deploymentId, agentAddress: addr }) => {
        registry.record(deploymentId, addr);
      },
      unregisterDeployment: ({ deploymentId }) => {
        registry.unregister(deploymentId);
      },
      multistepMailRouter: createMultistepMailRouter(),
      multistepSignalRouter: createMultistepSignalRouter(),
      multistepDrainRouter: createMultistepDrainRouter(),
    });

    const frame: AgentDeployFrame = {
      type: "agent.deploy",
      agentAddress,
      agentId: "ins_redeploy",
      hubPublicKey: "00".repeat(32),
      config: {
        agentAddress,
        agentId: "ins_redeploy",
        sessionId: "session-redeploy",
        sources: [],
        defaultSource: "primary",
        grants: [],
      } as unknown as AgentDeployFrame["config"],
    };

    await router.deploy(frame);
    await router.deploy(frame);

    // A second same-address deploy with no intervening teardown disposed the
    // first listener before attaching the second: exactly one listener
    // survives, so run-bracket events are not doubled/interleaved on one repo.
    expect(listeners.get(agentAddress)?.size).toBe(1);
  });
});
