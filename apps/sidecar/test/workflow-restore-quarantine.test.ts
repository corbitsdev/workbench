// Boot-time restore's failure accounting: a record whose failure is
// PERMANENT (deterministic, intrinsic to the record's own persisted
// bytes -- here, an address that derives a different slug than its
// on-disk directory) stops being attempted after
// RESTORE_QUARANTINE_THRESHOLD consecutive boots and collapses into a
// one-line summary; a record whose failure is TRANSIENT (this boot's
// environment -- here, an inference provider the sidecar cannot build)
// is retried every boot forever, however many times it has failed. Real
// child spawning is out of scope here (see workflow-deploy-lifecycle.test.ts);
// this only exercises the restore loop's classification and skip logic.

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
  RESTORE_QUARANTINE_THRESHOLD,
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
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-restore-"));
  tempDirs.push(dir);
  return dir;
}

const closureDefinitions = new Map<string, WorkflowDefinition>();

async function makeRouter(
  dataDir: string,
  opts: { assertSourceBuildable: (source: InferenceSource) => void },
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

function stageClosureDefinition(deploymentId: string): void {
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

function makeSource(provider: string): InferenceSource {
  return {
    id: `source-${provider}`,
    provider,
    baseURL: "https://inference.example.com",
    apiKey: "key",
    model: "model-1",
  };
}

const SOURCE_REF: WorkflowDeploymentRecord["sourceRef"] = {
  source: { kind: "registry", registry: "npm" },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
};

test("a permanently unrestorable record is quarantined after RESTORE_QUARANTINE_THRESHOLD boots and stops being attempted", async () => {
  const dataDir = await makeDataDir();
  const router = await makeRouter(dataDir, {
    assertSourceBuildable: () => undefined,
  });

  // A record filed under a directory that does not match what its own
  // agentAddress derives to -- corrupt/misplaced, and deterministically so:
  // no future boot ever makes `deriveDeploymentId` agree with the directory.
  const mismatchedDeploymentId = "dep_mismatched-directory";
  const record: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress: "run_permanent-case@example.com",
    definitionId: "def_1",
    sources: {},
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(dataDir, mismatchedDeploymentId, record);

  for (let boot = 1; boot <= RESTORE_QUARANTINE_THRESHOLD; boot++) {
    await router.restoreWorkflowDeployments();
    const onDisk = await readWorkflowDeploymentRecord(
      dataDir,
      mismatchedDeploymentId,
    );
    expect(onDisk?.restoreFailure?.kind).toBe("permanent");
    expect(onDisk?.restoreFailure?.attempts).toBe(boot);
  }

  const quarantined = await readWorkflowDeploymentRecord(
    dataDir,
    mismatchedDeploymentId,
  );
  expect(quarantined?.restoreFailure?.attempts).toBe(
    RESTORE_QUARANTINE_THRESHOLD,
  );

  // One more boot: quarantine means the attempt count does NOT move --
  // the record is skipped entirely rather than attempted and re-failed.
  await router.restoreWorkflowDeployments();
  const afterQuarantineBoot = await readWorkflowDeploymentRecord(
    dataDir,
    mismatchedDeploymentId,
  );
  expect(afterQuarantineBoot?.restoreFailure?.attempts).toBe(
    RESTORE_QUARANTINE_THRESHOLD,
  );

  // The record itself is never deleted -- an operator can still undeploy
  // the address to reclaim it.
  expect(afterQuarantineBoot?.agentAddress).toBe(record.agentAddress);
});

test("a transiently unbuildable provider is retried every boot and never quarantines", async () => {
  const dataDir = await makeDataDir();
  let assertCalls = 0;
  const router = await makeRouter(dataDir, {
    assertSourceBuildable: (source) => {
      assertCalls += 1;
      if (source.provider === "unbuildable") {
        throw new Error(
          `Source provider "${source.provider}" is not registered`,
        );
      }
    },
  });

  const agentAddress = "run_transient-case@example.com";
  const deploymentId = deriveDeploymentId(agentAddress);
  stageClosureDefinition(deploymentId);
  const record: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress,
    definitionId: "def_1",
    sources: { "step-1": [makeSource("unbuildable")] },
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, record);

  const bootCount = RESTORE_QUARANTINE_THRESHOLD + 2;
  for (let boot = 1; boot <= bootCount; boot++) {
    await router.restoreWorkflowDeployments();
  }

  // Every boot actually reached the source-admission gate -- nothing was
  // ever skipped, unlike the permanent case above.
  expect(assertCalls).toBe(bootCount);

  const onDisk = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  expect(onDisk?.restoreFailure?.kind).toBe("transient");
  expect(onDisk?.restoreFailure?.attempts).toBe(bootCount);
});
