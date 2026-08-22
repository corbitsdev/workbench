// CL-6648: a single-step ("warm-keep") deployment's persisted `sources`
// is only ever a snapshot of what resolved against the tenant catalog at
// its last deploy or rotation. Restoring one eagerly from that snapshot
// at boot would replay a chain whose credential died after the freeze
// forever -- the deployment reads as "already live" to every later wake
// check, so the folded-run wake path (`ensureAwake` ->
// `wakeFoldedRun`/`deployAtHead`, which DOES re-resolve fresh against the
// live catalog on every call) never gets a chance to heal it.
//
// The fix: boot-time restore defers a single-step deployment to that
// wake path instead of restoring it from frozen sources -- proven here by
// asserting the mock spawner is never invoked and the dead source is
// never even reaches `assertSourceBuildable`. A true multi-step
// deployment has no such wake port, so it must keep restoring eagerly
// from its frozen sources exactly as before -- proven by the sibling
// test below with an unchanged buildable-source multi-step record.

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
import type { InferenceSource } from "@intx/types/runtime";
import type { SubprocessSpawner } from "@intx/workflow-host";
import { defineWorkflow, step, type WorkflowDefinition } from "@intx/workflow";
import { buildSingleStepAgentDefinition } from "@intx/workflow-deploy";
import {
  createSidecarDeployRouter,
  deriveDeploymentId,
  type SidecarDeployRouter,
} from "../src/workflow-host-wiring";
import {
  readWorkflowDeploymentRecord,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "../src/workflow-deployment-record";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-restore-defer-"));
  tempDirs.push(dir);
  return dir;
}

const closureDefinitions = new Map<string, WorkflowDefinition>();

async function makeRouter(
  dataDir: string,
  opts: {
    assertSourceBuildable: (source: InferenceSource) => void;
    onSpawn: () => void;
  },
): Promise<SidecarDeployRouter> {
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
  const recordingSpawner: SubprocessSpawner = () => {
    opts.onSpawn();
    throw new Error("test spawner refuses to launch a real child");
  };
  return createSidecarDeployRouter({
    sessions,
    keyStore,
    transport: createInMemoryTransport(),
    repoStore: substrate.repoStore,
    signingKeySeed: signingKey.privateKey,
    createAgentCrypto: createEd25519Crypto,
    assertSourceBuildable: opts.assertSourceBuildable,
    registerDeployment: () => undefined,
    unregisterDeployment: () => undefined,
    multistepSubstrateEnv: { SIDECAR_DATA_DIR: dataDir },
    materializeDeploymentClosure: ({ deploymentId }) => {
      const definition = closureDefinitions.get(deploymentId);
      if (definition === undefined) {
        throw new Error(
          `test closure materializer: no definition registered for ${deploymentId}`,
        );
      }
      return Promise.resolve({
        definition,
        packageDir: path.join(dataDir, "closure-package", deploymentId),
        deployDir: path.join(dataDir, "closure-deploy", deploymentId),
      });
    },
    multistepSubprocessSpawner: recordingSpawner,
    multistepBinaryPath: path.join(dataDir, "workflow-child-sentinel"),
  });
}

function stageSingleStepClosureDefinition(deploymentId: string): void {
  closureDefinitions.set(
    deploymentId,
    defineWorkflow({
      id: "definition-1",
      trigger: { type: "mail", to: "definition-1@example.com" },
      steps: {
        "step-1": step({
          agent: buildSingleStepAgentDefinition({
            id: "step-1",
            systemPrompt: "",
            inferencePreferences: [],
            toolFactories: [],
          }),
          triggers: "unbounded",
        }),
      },
    }),
  );
}

function stageMultiStepClosureDefinition(deploymentId: string): void {
  closureDefinitions.set(
    deploymentId,
    defineWorkflow({
      id: "definition-multi",
      trigger: { type: "mail", to: "definition-multi@example.com" },
      steps: {
        "step-1": step({
          agent: buildSingleStepAgentDefinition({
            id: "step-1",
            systemPrompt: "",
            inferencePreferences: [],
            toolFactories: [],
          }),
          triggers: "unbounded",
        }),
        "step-2": step({
          agent: buildSingleStepAgentDefinition({
            id: "step-2",
            systemPrompt: "",
            inferencePreferences: [],
            toolFactories: [],
          }),
          triggers: "unbounded",
        }),
      },
    }),
  );
}

function makeDeadSource(provider: string): InferenceSource {
  return {
    id: `source-${provider}`,
    provider,
    baseURL: "https://api.example.com",
    apiKey: "sk-dead-key-from-before-a-provider-reconfigure",
    model: "model-1",
  };
}

const SOURCE_REF: WorkflowDeploymentRecord["sourceRef"] = {
  source: { kind: "registry", registry: "npm" },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
};

test("a single-step deployment's frozen dead source is never replayed at restore -- it defers to the wake path instead", async () => {
  const dataDir = await makeDataDir();
  let assertSourceBuildableCalls = 0;
  let spawnCalls = 0;
  const agentAddress = "run_dana-myra-frozen-anthropic@example.com";
  const deploymentId = deriveDeploymentId(agentAddress);
  stageSingleStepClosureDefinition(deploymentId);

  const router = await makeRouter(dataDir, {
    assertSourceBuildable: () => {
      assertSourceBuildableCalls += 1;
    },
    onSpawn: () => {
      spawnCalls += 1;
    },
  });

  const record: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress,
    definitionId: "def_1",
    // A single-step deployment's `sources` table has exactly one entry,
    // per `validateWorkflowProjection`'s own wire invariant -- this is
    // the dead, pre-reconfigure Anthropic chain the ticket describes.
    sources: { "step-1": [makeDeadSource("anthropic")] },
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, record);

  await router.restoreWorkflowDeployments();

  // Never even reached the source-admission gate or a spawn attempt --
  // the dead source's buildability was never checked because the
  // deployment was deferred before it was consulted at all.
  expect(assertSourceBuildableCalls).toBe(0);
  expect(spawnCalls).toBe(0);
  expect(router.activeAddresses()).not.toContain(agentAddress);

  // The record is untouched: no restore failure was recorded (this was
  // never attempted, let alone failed), and the frozen sources are left
  // exactly as they were for the next wake to overwrite once it
  // re-resolves against the live catalog.
  const onDisk = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  expect(onDisk?.restoreFailure).toBeUndefined();
  expect(onDisk?.sources).toEqual(record.sources);
});

test("a multi-step deployment still restores eagerly from its frozen sources, unchanged", async () => {
  const dataDir = await makeDataDir();
  let assertSourceBuildableCalls = 0;
  let spawnCalls = 0;
  const agentAddress = "run_multi-step-unchanged@example.com";
  const deploymentId = deriveDeploymentId(agentAddress);
  stageMultiStepClosureDefinition(deploymentId);

  const router = await makeRouter(dataDir, {
    assertSourceBuildable: () => {
      assertSourceBuildableCalls += 1;
    },
    onSpawn: () => {
      spawnCalls += 1;
    },
  });

  const record: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress,
    definitionId: "def_multi",
    sources: {
      "step-1": [makeDeadSource("buildable-1")],
      "step-2": [makeDeadSource("buildable-2")],
    },
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, record);

  await router.restoreWorkflowDeployments();

  // Every source in the frozen chain was gated for buildability, and the
  // (mock) spawn was attempted -- multi-step restore behavior is
  // unaffected by CL-6648's single-step deferral.
  expect(assertSourceBuildableCalls).toBe(2);
  expect(spawnCalls).toBe(1);

  // The mock spawner throws, so the restore attempt fails (as it did
  // before this change) -- transient, since a plain thrown `Error` from
  // the spawn core is the default classification.
  const onDisk = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  expect(onDisk?.restoreFailure?.kind).toBe("transient");
  expect(onDisk?.sources).toEqual(record.sources);
});
