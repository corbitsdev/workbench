// The per-run grants barrier fails closed. Every run birth path produces a
// `run.grants` frame (the hub's `deployAtHead` sends it once the deploy acks),
// so a run reaching `assembleRunCredentialsSnapshot` with no
// `runs/<runId>/grants.json` is a run that would start under-authorized, not a
// run legitimately inheriting deploy-time grants. This pins that a missing
// file throws rather than resolving to an empty snapshot, and that a present
// file is applied uniformly across the deployment's steps.

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assembleRunCredentialsSnapshot } from "../src/workflow-host-wiring/supervisor";
import { writeStepGrants } from "../src/workflow-host-wiring/step-strategy";
import { createSpawnTestRepoStore } from "./support/workflow-lifecycle-fixture";

const DEPLOYMENT_ID = "dep-barrier";
const STEP_ORDER = ["step-a", "step-b"];
const deriveStepAddress = ({ stepId }: { stepId: string }) =>
  `${DEPLOYMENT_ID}-${stepId}@local`;

// Wrapped in an object: the stub store is a Proxy that throws on any
// unknown property, so returning it bare from an async function makes the
// promise machinery probe `then` and blow up.
async function makeRepoStore() {
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "grants-barrier-"));
  return { store: createSpawnTestRepoStore(tempBase) };
}

describe("assembleRunCredentialsSnapshot", () => {
  test("throws when the run has no grants file", async () => {
    const { store: repoStore } = await makeRepoStore();

    await expect(
      assembleRunCredentialsSnapshot({
        repoStore,
        deploymentId: DEPLOYMENT_ID,
        runId: "run-missing",
        stepOrder: STEP_ORDER,
        deriveStepAddress,
      }),
    ).rejects.toThrow(/has no grants file; failing closed/);
  });

  test("applies a written run's grants across every step", async () => {
    const { store: repoStore } = await makeRepoStore();
    const grants = [
      {
        id: "grant_1",
        resource: "tool:@corbits/mcp-tools:search",
        action: "invoke",
        effect: "allow" as const,
        origin: "system" as const,
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: "prn_1",
      },
    ];

    await writeStepGrants({
      repoStore,
      deploymentId: DEPLOYMENT_ID,
      stepOrder: STEP_ORDER,
      // Inert in per-run mode: `writeStepGrants` with a `runId` writes the
      // single `runs/<runId>/grants.json` into the deployment's workflow-run
      // repo rather than fanning out to per-step repos.
      deriveStepRepoId: ({ stepId }) => ({
        kind: "agent-state" as const,
        id: `${DEPLOYMENT_ID}-${stepId}`,
      }),
      grants,
      runId: "run-present",
    });

    const snapshot = await assembleRunCredentialsSnapshot({
      repoStore,
      deploymentId: DEPLOYMENT_ID,
      runId: "run-present",
      stepOrder: STEP_ORDER,
      deriveStepAddress,
    });

    expect(snapshot.steps.map((step) => step.stepId)).toEqual(STEP_ORDER);
    for (const step of snapshot.steps) {
      expect(step.grants).toEqual(grants);
      expect(step.address).toBe(deriveStepAddress({ stepId: step.stepId }));
    }
    expect(new Set(snapshot.steps.map((step) => step.contentHash)).size).toBe(
      1,
    );
  });
});
