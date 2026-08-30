// CL-7215: `withRestoreTimeout` used to race a boot-restore attempt
// against a timer and, on timeout, simply abandon the still-running
// attempt -- if it later succeeded, `spawnWorkflowDeployment` registered
// a live supervisor for an address the boot loop had already recorded as
// a restore FAILURE. This exercises the fix: a restore that overshoots
// its timeout still gets an `AbortSignal`, and once it actually finishes
// (late), it corrects its own durable record instead of leaving a live
// deployment marked failed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { defineWorkflow, step, type WorkflowDefinition } from "@intx/workflow";
import { buildSingleStepAgentDefinition } from "@intx/workflow-deploy";
import type { InferenceSource } from "@intx/types/runtime";

import { deriveDeploymentId } from "../src/workflow-host-wiring";
import {
  readWorkflowDeploymentRecord,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "../src/workflow-deployment-record";
import {
  answerReadyHandshake,
  makeLifecycleFixture,
} from "./support/workflow-lifecycle-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-restore-timeout-"));
  tempDirs.push(dir);
  return dir;
}

// Two steps, deliberately: a single-step ("warm-keep") record defers to its
// wake path instead of eagerly restoring (CL-6648), so it never reaches
// `spawnWorkflowDeployment` and could never exercise this timeout path.
const TWO_STEP_DEFINITION: WorkflowDefinition = defineWorkflow({
  id: "wf-restore-timeout",
  trigger: { type: "mail", to: "wf-restore-timeout@example.com" },
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
});

function makeSource(): InferenceSource {
  return {
    id: "source-1",
    provider: "buildable",
    baseURL: "https://inference.example.com",
    apiKey: "key",
    model: "model-1",
  };
}

const SOURCE_REF: WorkflowDeploymentRecord["sourceRef"] = {
  source: { kind: "registry", registry: "npm" },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
};

test("a restore that outlasts its timeout corrects its record once the spawn actually finishes, instead of leaving a live deployment marked failed", async () => {
  const dataDir = await makeDataDir();
  const restoreAttemptTimeoutMs = 25;

  const { router, spawns } = await makeLifecycleFixture({
    dataDir,
    restoreAttemptTimeoutMs,
    materializeDeploymentClosure: ({ deploymentId }) =>
      Promise.resolve({
        definition: TWO_STEP_DEFINITION,
        packageDir: path.join(dataDir, "closure-package", deploymentId),
        deployDir: path.join(dataDir, "closure-deploy", deploymentId),
      }),
  });

  const agentAddress = "run_late-restore@example.com";
  const deploymentId = deriveDeploymentId(agentAddress);
  const record: WorkflowDeploymentRecord = {
    version: 1,
    agentAddress,
    definitionId: "def_1",
    sources: {
      "step-1": [makeSource()],
      "step-2": [makeSource()],
    },
    approvedWireHash: "d".repeat(64),
    sourceRef: SOURCE_REF,
  };
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, record);

  // Don't answer the ready handshake yet: `wired.supervisor.spawn()` stays
  // pending well past `restoreAttemptTimeoutMs`, so the boot loop's own
  // timeout fires and records this attempt as a boot failure first.
  const restorePromise = router.restoreWorkflowDeployments();
  await restorePromise;

  const afterTimeout = await readWorkflowDeploymentRecord(
    dataDir,
    deploymentId,
  );
  expect(afterTimeout?.restoreFailure).toBeDefined();
  expect(router.activeAddresses()).toEqual([]);

  // The underlying restore was never abandoned: answering the handshake now
  // lets `spawnWorkflowDeployment` actually finish, well after the boot
  // loop already gave up on it.
  await answerReadyHandshake(spawns, 0);

  // Both the live registration AND the record correction are background
  // continuations of the restore attempt, not something
  // `restoreWorkflowDeployments()` awaits -- and the registration lands
  // strictly before the correction (the correction only runs once
  // `spawnWorkflowDeployment` has already resolved). Poll on the record
  // correction specifically, since it's the last of the two to land.
  let afterLateRestore: WorkflowDeploymentRecord | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    afterLateRestore = await readWorkflowDeploymentRecord(
      dataDir,
      deploymentId,
    );
    if (afterLateRestore?.restoreFailure === undefined) break;
    await new Promise((r) => setTimeout(r, 5));
  }

  // The deployment is genuinely live now -- the record must no longer
  // claim it failed to restore.
  expect(afterLateRestore?.restoreFailure).toBeUndefined();
  expect(router.activeAddresses()).toEqual([agentAddress]);
});
