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
// CL-6640 fixture: deployment ids in this set fail materialization with
// the exact wrapped-ENOENT shape `readPackageJSON` (`@intx/workflow-host`)
// throws when a closure's staged `package.json` is missing.
const closureMissingStagingDir = new Set<string>();

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
      if (closureMissingStagingDir.has(deploymentId)) {
        const rawEnoent = new Error(
          "ENOENT: no such file or directory, open '.../store/@workbench-seed/last-30-days-research/0.0.0/package.json'",
        ) as Error & { code: string };
        rawEnoent.code = "ENOENT";
        throw new Error(
          `cannot read package.json for workflow package at ${dataDir}/workflow-definition-closures/${deploymentId}/packages/some-fresh-uuid/store/@workbench-seed/last-30-days-research/0.0.0`,
          { cause: rawEnoent },
        );
      }
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

// CL-6640: the sidecar crash-looped on boot because an ENOENT reading a
// closure's `package.json` -- observed for a UUID staging directory
// `applyFrozenWorkflowClosure` had just minted and populated moments
// earlier -- was falling through the boot loop's default "transient"
// classification, which never quarantines, so the record was retried
// forever and (by a mechanism outside this test's scope) the process
// itself died and was relaunched. This fabricates that exact failure
// shape -- `readPackageJSON`'s wrapped-ENOENT `Error` -- from the
// closure-materialization seam and proves: (a) the boot loop classifies
// it PERMANENT and quarantines it rather than retrying forever, (b) a
// sibling record's restore is still attempted every boot, unaffected, and
// (c) `restoreWorkflowDeployments()` itself never throws -- boot
// completes either way.
test("a missing/incomplete closure staging directory quarantines as a permanent failure without stopping the boot restore loop", async () => {
  const dataDir = await makeDataDir();
  const brokenAgentAddress = "run_missing-staging-dir@example.com";
  const brokenDeploymentId = deriveDeploymentId(brokenAgentAddress);
  closureMissingStagingDir.add(brokenDeploymentId);

  const healthyAgentAddress = "run_sibling-case@example.com";
  const healthyDeploymentId = deriveDeploymentId(healthyAgentAddress);
  stageClosureDefinition(healthyDeploymentId);

  const router = await makeRouter(dataDir, {
    assertSourceBuildable: () => undefined,
  });

  const brokenRecord: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress: brokenAgentAddress,
    definitionId: "def_1",
    sources: {},
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(
    dataDir,
    brokenDeploymentId,
    brokenRecord,
  );

  const healthyRecord: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress: healthyAgentAddress,
    definitionId: "def_1",
    // A buildable provider clears the source-admission gate and reaches
    // `spawnWorkflowDeployment`, where the test's `recordingSpawner`
    // refuses to launch a real child -- a plain `Error`, classified
    // "transient" by the boot loop's default. What matters for this test
    // is only that this record's own restore is attempted every boot,
    // independent of the broken sibling record.
    sources: { "step-1": [makeSource("buildable")] },
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(
    dataDir,
    healthyDeploymentId,
    healthyRecord,
  );

  for (let boot = 1; boot <= RESTORE_QUARANTINE_THRESHOLD; boot++) {
    // Boot completes without throwing -- the ENOENT never escapes the
    // restore loop, however it is classified.
    await expect(router.restoreWorkflowDeployments()).resolves.toBeUndefined();
    const broken = await readWorkflowDeploymentRecord(
      dataDir,
      brokenDeploymentId,
    );
    expect(broken?.restoreFailure?.kind).toBe("permanent");
    expect(broken?.restoreFailure?.attempts).toBe(boot);

    // The sibling deployment's own restore was attempted on every boot,
    // unaffected by the broken record ahead of (or behind) it in the scan.
    const healthy = await readWorkflowDeploymentRecord(
      dataDir,
      healthyDeploymentId,
    );
    expect(healthy?.restoreFailure?.kind).toBe("transient");
    expect(healthy?.restoreFailure?.attempts).toBe(boot);
  }

  // One more boot: quarantined now, so the attempt count stops moving --
  // the record is skipped rather than re-attempted and re-failed.
  await router.restoreWorkflowDeployments();
  const afterQuarantine = await readWorkflowDeploymentRecord(
    dataDir,
    brokenDeploymentId,
  );
  expect(afterQuarantine?.restoreFailure?.attempts).toBe(
    RESTORE_QUARANTINE_THRESHOLD,
  );
});
