// Pins H-A1 + CL-2400: a deploy-router rejection must not leave the
// `DeploymentAddressRegistry` populated.
//
// CL-2400 reordered registration: the router now records the
// `(deploymentId -> agentAddress)` mapping BEFORE `supervisor.spawn`
// (multi-step) / `supervisor.deploy` (trivial), because those steps
// commit run events through the workflow-run pack-push pipeline, which
// resolves the agent address via this registry -- registering after
// spawn made the push throw "no agent address registered" and the
// supervisor swallowed it as a best-effort warn, losing the event.
//
// The original H-A1 invariant (registry clean on deploy failure) is
// preserved by unwinding the early registration: a failure after the
// reordered `registerDeployment` invokes `unregisterDeployment` in the
// `finally`. The link's `handleAgentDeploy` catches the rejection and
// sends `agent.error` without invoking `deployRouter.undeploy(frame)`,
// so without the unwind the registry would retain a mapping for a
// deployment that never stood up.
//
// Both branches drive their failure path through this test and assert
// BOTH properties: (1) the mapping is already recorded at the moment
// the throwy step runs (proves register-before-spawn), and (2) the
// registry is clean after the failure (proves the unwind):
//   - trivial: `sessions.provisionAgent` throws.
//   - multi-step: the subprocess spawner throws synchronously so
//     `supervisor.spawn` rejects.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";

import { describe, test, expect } from "bun:test";
import { createInMemoryTransport } from "@intx/mail-memory";
import { createNodeCrypto, generateKeyPair } from "@intx/crypto-node";
import type { RepoId, RepoStore } from "@intx/hub-sessions";
import type { AgentDeployFrame } from "@intx/types/sidecar";
import type { SubprocessSpawner } from "@workbench/workflow-host";

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
      // The single-step multi-step branch registers the agent's signing
      // key on the host transport before `spawn()` (OUTBOUND half of
      // mailbox ownership). Return a real keypair so that registration
      // succeeds and the SPAWNER failure remains the failure this test
      // exercises.
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

function stubFailingSessions(
  onProvision?: () => void,
): Parameters<typeof createSidecarDeployRouter>[0]["sessions"] {
  return {
    async provisionAgent() {
      onProvision?.();
      throw new Error("provisionAgent forced failure");
    },
  } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["sessions"];
}

function makeRouterDeps() {
  const registry = createDeploymentAddressRegistry();
  const mailRouter = createMultistepMailRouter();
  const signalRouter = createMultistepSignalRouter();
  const drainRouter = createMultistepDrainRouter();
  const transport = createInMemoryTransport();
  return { registry, mailRouter, signalRouter, drainRouter, transport };
}

describe("deploy-failure registry leak", () => {
  test("trivial deploy: provisionAgent throws and registry stays clean", async () => {
    const { registry, mailRouter, signalRouter, drainRouter, transport } =
      makeRouterDeps();

    const slug = deriveTrivialDeploymentId("agent-fail@x.example");
    const probe: { resolvedAtProvision: string | null } = {
      resolvedAtProvision: null,
    };
    const sessions = stubFailingSessions(() => {
      probe.resolvedAtProvision = registry.resolve(slug);
    });
    const keyStore = stubKeyStore();

    const router = createSidecarDeployRouter({
      sessions,
      keyStore,
      onAgentEvent: () => () => undefined,
      transport,

      repoStore: {} as Parameters<
        typeof createSidecarDeployRouter
      >[0]["repoStore"],
      signingKeySeed: new Uint8Array(32),
      createAgentCrypto: createNodeCrypto,
      registerDeployment: ({ deploymentId, agentAddress }) => {
        registry.record(deploymentId, agentAddress);
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
      agentAddress: "agent-fail@x.example",
      agentId: "agent-fail",
      hubPublicKey: "00".repeat(32),

      config: {
        agentAddress: "agent-fail@x.example",
        agentId: "agent-fail",
        sessionId: "session-fail",
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

    // Register-before-deploy: the mapping was live when `provisionAgent` ran.
    expect(probe.resolvedAtProvision).toBe("agent-fail@x.example");
    // Unwind: the failed deploy left the registry clean.
    expect(registry.resolve(slug)).toBeNull();
  });

  test("multi-step deploy: spawn-time failure leaves registry clean", async () => {
    const { registry, mailRouter, signalRouter, drainRouter, transport } =
      makeRouterDeps();
    const sessions = stubFailingSessions();
    const keyStore = stubKeyStore();

    const slug = deriveTrivialDeploymentId("ins_mstep@x.example");
    const probe: { resolvedAtSpawn: string | null } = { resolvedAtSpawn: null };
    const failingSpawner: SubprocessSpawner = () => {
      probe.resolvedAtSpawn = registry.resolve(slug);
      throw new Error("spawner forced failure");
    };

    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "h-a1-deploy-failure-"));

    // The grants bridge writes `state/grants.json` to each step's
    // agent-state repo before `spawn()`; supply a minimal RepoStore that
    // honors `getRepoDir` + `writeTree` so the bridge succeeds and the
    // SPAWNER failure is the one this test exercises.
    const repoStoreStub: Partial<RepoStore> = {
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
        return Promise.resolve({ commitSha: "stub-sha" });
      },
    };

    const router = createSidecarDeployRouter({
      sessions,
      keyStore,
      onAgentEvent: () => () => undefined,
      transport,

      repoStore: repoStoreStub as RepoStore,
      signingKeySeed: new Uint8Array(32),
      createAgentCrypto: createNodeCrypto,
      registerDeployment: ({ deploymentId, agentAddress }) => {
        registry.record(deploymentId, agentAddress);
      },
      unregisterDeployment: ({ deploymentId }) => {
        registry.unregister(deploymentId);
      },
      multistepMailRouter: mailRouter,
      multistepSignalRouter: signalRouter,
      multistepDrainRouter: drainRouter,
      // The boot-edge substrate constants the router merges into the
      // assembled child env; `assertSubstrateEnvComplete` (CL-2363) fails the
      // deploy before spawn if any `SIDECAR_SUBSTRATE_CONFIG_KEYS` member is
      // missing, so supply the full set the router does not inject per-deploy.
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: tmpDir,
        SIDECAR_SIGNING_PUBLIC_KEY: "00".repeat(32),
        SIDECAR_SIGNING_PRIVATE_KEY: "00".repeat(32),
        HUB_WS_URL: "ws://test",
        SIDECAR_ID: "sc",
        SIDECAR_TOKEN: "tok",
        SIDECAR_CACHE_MAX_BYTES: "1000000",
        SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "1000000",
        PATH: "/usr/bin",
      },
      multistepSubprocessSpawner: failingSpawner,
    });

    const frame: AgentDeployFrame = {
      type: "agent.deploy",
      // Single-step projection: the deploy router parses the frame
      // address into the legacy agent-state repo id, so it must carry the
      // canonical `ins_<id>@<domain>` shape.
      agentAddress: "ins_mstep@x.example",
      // `agentId` must carry the orchestrator's `deriveDeploymentAgentId`
      // shape "ins_<rawDeploymentId>" (CL-2199) or `deriveRawDeploymentId`
      // throws before spawn -- the failure this test means to exercise is
      // the subprocess spawner rejecting inside `supervisor.spawn`.
      agentId: "ins_mstep",
      hubPublicKey: "00".repeat(32),

      config: {
        agentAddress: "ins_mstep@x.example",
        agentId: "ins_mstep",
        sessionId: "s",
        sources: [],
        defaultSource: "primary",
        grants: [],
        // `TENANT_ID` (CL-2199) is threaded from `config.tenantId`;
        // `assertSubstrateEnvComplete` rejects an empty value before spawn.
        tenantId: "tnt_test",
      } as unknown as AgentDeployFrame["config"],
      workflow: {
        definition: {
          id: "wf-1",
          triggers: [{ type: "manual" }],
          stepOrder: ["s1"],
          steps: { s1: { kind: "step" } },
        },
        sources: {
          s1: {
            id: "primary",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com",
            apiKey: "sk-x",
            model: "claude-3-5",
          },
        },
      },
    };

    let threw = false;
    try {
      await router.deploy(frame);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Register-before-spawn: the mapping was live when the spawner ran.
    expect(probe.resolvedAtSpawn).toBe("ins_mstep@x.example");
    // Unwind: the failed deploy left the registry clean.
    expect(registry.resolve(slug)).toBeNull();
  });
});
