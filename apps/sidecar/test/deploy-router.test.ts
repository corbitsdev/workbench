// Deploy-router surface wiring: the provision-step staging branch, the
// unsupported-frame refusal, and the source-admission gate ordering
// (a deploy with an unbuildable provider is rejected before any child
// is spawned). Supervisor scheduling and child IPC are the published
// packages' concern and are not re-proven here.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createEd25519Crypto,
  generateKeyPair,
  signEd25519,
  verifySSHSignature,
} from "@intx/crypto";
import {
  createAgentKeyStore,
  createAgentRepoStore as createSidecarSideRepoStore,
  createSessionManager,
} from "@intx/hub-agent";
import { createAgentRepoStore } from "@intx/hub-sessions";
import { createInMemoryTransport } from "@intx/mail-memory";
import { hexEncode } from "@intx/types";
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type { AgentDeployFrame } from "@intx/types/sidecar";
import type { SubprocessSpawner } from "@intx/workflow-host";
import {
  createSidecarDeployRouter,
  deriveDeploymentId,
  type SidecarDeployRouter,
} from "../src/workflow-host-wiring";
import { assembleRunCredentialsSnapshot } from "../src/workflow-host-wiring/supervisor";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-router-"));
  tempDirs.push(dir);
  return dir;
}

type RouterFixture = {
  router: SidecarDeployRouter;
  spawnedBinaries: string[];
  rejectedSources: InferenceSource[];
};

async function makeRouter(dataDir: string): Promise<RouterFixture> {
  const signingKey = await generateKeyPair();
  const substrate = createAgentRepoStore({ dataDir, signingKey });
  const repoStore = createSidecarSideRepoStore({ dataDir });
  const sessions = createSessionManager({ repoStore });
  const keyStore = createAgentKeyStore({
    dataDir,
    generateKeyPair,
    signEd25519,
    verifySSHSig: verifySSHSignature,
  });
  const spawnedBinaries: string[] = [];
  const recordingSpawner: SubprocessSpawner = ({ binaryPath }) => {
    spawnedBinaries.push(binaryPath);
    throw new Error("test spawner refuses to launch a real child");
  };
  const rejectedSources: InferenceSource[] = [];
  const router = createSidecarDeployRouter({
    sessions,
    keyStore,
    transport: createInMemoryTransport(),
    repoStore: substrate.repoStore,
    signingKeySeed: signingKey.privateKey,
    createAgentCrypto: createEd25519Crypto,
    assertSourceBuildable: (source) => {
      if (source.provider === "unbuildable") {
        rejectedSources.push(source);
        throw new Error(`provider ${source.provider} is not registered`);
      }
    },
    registerDeployment: () => undefined,
    unregisterDeployment: () => undefined,
    multistepSubstrateEnv: { SIDECAR_DATA_DIR: dataDir },
    multistepSubprocessSpawner: recordingSpawner,
    multistepBinaryPath: path.join(dataDir, "workflow-child-sentinel"),
  });
  return { router, spawnedBinaries, rejectedSources };
}

function makeHarnessConfig(agentAddress: string): HarnessConfig {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    tenantId: "org-1",
    principalId: "principal-1",
    agentAddress,
    systemPrompt: "",
    tools: [],
    grants: [],
    sources: [],
    defaultSource: "source-1",
  };
}

function makeSource(provider: string): InferenceSource {
  return {
    id: `source-${provider}`,
    provider,
    baseURL: "https://inference.example.com",
    apiKey: "key",
    model: "model-1",
  };
}

test("provision-step frame stages the step repo and acks a public key", async () => {
  const dataDir = await makeDataDir();
  const { router, spawnedBinaries } = await makeRouter(dataDir);
  const hubKey = await generateKeyPair();
  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress: "ins_dep_1-step-1@example.com",
    agentId: "agent-1",
    config: makeHarnessConfig("ins_dep_1-step-1@example.com"),
    hubPublicKey: hexEncode(hubKey.publicKey),
    provisionStep: true,
  };

  const result = await router.deploy(frame);

  expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);
  // Provisioning spawns nothing; the deployment-level workflow frame does.
  expect(spawnedBinaries).toEqual([]);
  expect(router.activeAddresses()).toEqual([]);
});

test("a frame with neither provisionStep nor workflow is refused", async () => {
  const dataDir = await makeDataDir();
  const { router } = await makeRouter(dataDir);
  const hubKey = await generateKeyPair();
  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress: "ins_dep_1@example.com",
    agentId: "agent-1",
    config: makeHarnessConfig("ins_dep_1@example.com"),
    hubPublicKey: hexEncode(hubKey.publicKey),
  };

  await expect(router.deploy(frame)).rejects.toThrow(
    /provisionStep or a workflow definition/,
  );
});

test("an unbuildable inference provider rejects the deploy before any spawn", async () => {
  const dataDir = await makeDataDir();
  const { router, spawnedBinaries, rejectedSources } =
    await makeRouter(dataDir);
  const hubKey = await generateKeyPair();
  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress: "ins_dep_1@example.com",
    agentId: "agent-1",
    config: makeHarnessConfig("ins_dep_1@example.com"),
    hubPublicKey: hexEncode(hubKey.publicKey),
    workflow: {
      definition: {
        id: "definition-1",
        triggers: [],
        stepOrder: ["step-1"],
        steps: { "step-1": {} },
      },
      sources: { "step-1": [makeSource("unbuildable")] },
    },
  };

  await expect(router.deploy(frame)).rejects.toThrow(/not registered/);
  expect(rejectedSources).toHaveLength(1);
  expect(spawnedBinaries).toEqual([]);
  expect(router.activeAddresses()).toEqual([]);
});

test("a malformed workflow projection is refused at the router edge", async () => {
  const dataDir = await makeDataDir();
  const { router, spawnedBinaries } = await makeRouter(dataDir);
  const hubKey = await generateKeyPair();
  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress: "ins_dep_1@example.com",
    agentId: "agent-1",
    config: makeHarnessConfig("ins_dep_1@example.com"),
    hubPublicKey: hexEncode(hubKey.publicKey),
    workflow: {
      definition: {
        id: "definition-1",
        triggers: [],
        stepOrder: [],
        steps: {},
      },
      sources: {},
    },
  };

  await expect(router.deploy(frame)).rejects.toThrow(/stepOrder/);
  expect(spawnedBinaries).toEqual([]);
});

// `spawn` replays any mail already sitting in the deployment's inbox, which
// births the self-anchored run immediately -- before the hub's own
// `run.grants` frame can arrive, since that is only sent once the deploy
// acks. The deploy must therefore put the run's grants on disk itself, or
// every wake with mail pending fails its `onRunStart` barrier closed and the
// agent goes silent. The spawner here throws, so reaching the assertion at
// all proves the write lands BEFORE the spawn.
test("a single-step deploy writes the self-anchored run's grants before spawning", async () => {
  const dataDir = await makeDataDir();
  const { router } = await makeRouter(dataDir);
  const hubKey = await generateKeyPair();
  const agentAddress = `run_${"a1".repeat(16)}@example.com`;
  const runId = `run_${"a1".repeat(16)}`;
  const grant = {
    id: "grant_1",
    resource: "tool:@corbits/memory-tools:memory_search",
    action: "invoke",
    effect: "allow" as const,
    origin: "system" as const,
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: "principal-1",
  };
  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress,
    agentId: "agent-1",
    config: { ...makeHarnessConfig(agentAddress), grants: [grant] },
    hubPublicKey: hexEncode(hubKey.publicKey),
    workflow: {
      definition: {
        id: "definition-1",
        triggers: [],
        stepOrder: ["step-1"],
        steps: { "step-1": {} },
      },
      sources: { "step-1": [makeSource("openai")] },
    },
  };

  await expect(router.deploy(frame)).rejects.toThrow(
    /refuses to launch a real child/,
  );

  const substrate = createAgentRepoStore({
    dataDir,
    signingKey: await generateKeyPair(),
  });
  const snapshot = await assembleRunCredentialsSnapshot({
    repoStore: substrate.repoStore,
    deploymentId: deriveDeploymentId(agentAddress),
    runId,
    stepOrder: ["step-1"],
    deriveStepAddress: () => agentAddress,
  });
  expect(snapshot.steps).toHaveLength(1);
  expect(snapshot.steps[0]?.grants).toEqual([grant]);
});
