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

test("a reclaiming teardown racing a dangling restore's boot-failure write is not resurrected with a false restoreFailure, and the restore's late spawn does not orphan a live supervisor with no record", async () => {
  // The unwind this test exercises routes through `teardownDeployment`'s
  // real `drain`/kill-escalation timers (`TEARDOWN_DRAIN_DEADLINE_MS` =
  // 5000ms, `CHILD_KILL_ESCALATION_MS` = 3000ms). Bun's 5000ms default test
  // timeout leaves no margin against that combined worst case, so both this
  // timeout and the poll deadline below give it headroom past it.
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

  const agentAddress = "run_teardown-race@example.com";
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

  // Don't answer the ready handshake yet: the restore's spawn stays pending
  // past `restoreAttemptTimeoutMs`, leaving a window for a concurrent
  // teardown to race it.
  const restorePromise = router.restoreWorkflowDeployments();

  // Wait for the restore to actually reach the spawn (i.e. the mock
  // spawner has been invoked) before racing a teardown against it.
  // Racing it any earlier collides with a DIFFERENT, unrelated race: the
  // boot scan's own directory read of this same record file, which the
  // scan already handles by skipping a record it can no longer read --
  // that would starve this test of the spawn-in-flight race it exists to
  // exercise.
  const spawnDeadline = Date.now() + 2000;
  while (Date.now() < spawnDeadline && spawns.length === 0) {
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(spawns).toHaveLength(1);

  // Race a reclaiming teardown against the still-in-flight restore, before
  // its boot-restore timeout fires. `activeSupervisors` has no entry for
  // this address yet (the spawn handshake is unanswered), so this exercises
  // the ordinary "operator undeploys mid-restore" path, not the
  // already-live-supervisor guard the other test above covers.
  await router.teardownDeployment(agentAddress, { reclaimDirs: true });

  await restorePromise;

  // The teardown deleted the record before the boot loop's own timeout
  // catch could write to it. `recordWorkflowDeploymentRestoreFailure`
  // re-reads from disk and must no-op on a missing record rather than
  // resurrecting `deployment.json` with a false restoreFailure for a
  // deployment that was fully reclaimed (CL-7215).
  const afterRace = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  expect(afterRace).toBeUndefined();

  // The underlying restore was never abandoned: answering the handshake now
  // lets `spawnWorkflowDeployment` finish, well after the teardown already
  // reclaimed this address. Without reconciling against the now-missing
  // record, this would register a live supervisor with no durable record
  // behind it -- an orphaned deployment, invisible to any future boot scan.
  await answerReadyHandshake(spawns, 0);

  // Poll for the unwind: it is a background continuation of the restore
  // attempt, not something `restoreWorkflowDeployments()` awaits.
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    router.activeAddresses().includes(agentAddress)
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(router.activeAddresses()).toEqual([]);
  const afterUnwind = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  expect(afterUnwind).toBeUndefined();
}, 15_000);
