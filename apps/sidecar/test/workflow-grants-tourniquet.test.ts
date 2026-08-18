// CL-6194 grants-frame gap: this hub does not yet ship the per-run
// `run.grants` frame before a run starts, so `assembleRunCredentialsSnapshot`
// (supervisor.ts) returns an empty-per-step snapshot instead of failing
// closed on a missing grants file, and `spawnWorkflowDeployment`
// (workflow-host-wiring/index.ts) makes a one-shot post-spawn
// `deliverCredentials` push to compensate with the real material. Both read
// the SAME exported `CL_6194_GRANTS_FRAME_GAP_OPEN` seam rather than two
// independently-reasoned judgment calls. This test proves the two
// compensations cannot be removed independently: flipping the seam off
// makes `assembleRunCredentialsSnapshot` fail closed AND stops the
// post-spawn push from firing, in the same run.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleRunCredentialsSnapshot,
  CL_6194_GRANTS_FRAME_GAP_OPEN,
  setGrantsFrameGapOpenForTest,
} from "../src/workflow-host-wiring/supervisor";
import {
  createSpawnTestRepoStore,
  answerReadyHandshake,
  makeLifecycleFixture,
  makeWorkflowFrame,
} from "./support/workflow-lifecycle-fixture";

afterEach(() => {
  // Restore the seam for every other test in the process: bun runs test
  // files in one process, so a leaked `false` would fail-close every other
  // suite's missing-grants-file deploys.
  setGrantsFrameGapOpenForTest(true);
});

describe("CL_6194_GRANTS_FRAME_GAP_OPEN gates both compensations together", () => {
  test("closing the seam fails assembleRunCredentialsSnapshot closed AND stops the post-spawn deliverCredentials push", async () => {
    expect(CL_6194_GRANTS_FRAME_GAP_OPEN).toBe(true);

    const tempBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "grants-tourniquet-"),
    );
    const repoStore = createSpawnTestRepoStore(tempBase);

    // With the gap open (default), a missing grants file resolves to an
    // empty-per-step snapshot rather than throwing.
    await expect(
      assembleRunCredentialsSnapshot({
        repoStore,
        deploymentId: "dep-tourniquet",
        runId: "run-missing",
        stepOrder: ["step-a"],
        deriveStepAddress: ({ stepId }) => `dep-tourniquet-${stepId}@local`,
      }),
    ).resolves.toBeDefined();

    setGrantsFrameGapOpenForTest(false);

    // Half one: assembleRunCredentialsSnapshot now fails closed.
    await expect(
      assembleRunCredentialsSnapshot({
        repoStore,
        deploymentId: "dep-tourniquet",
        runId: "run-missing",
        stepOrder: ["step-a"],
        deriveStepAddress: ({ stepId }) => `dep-tourniquet-${stepId}@local`,
      }),
    ).rejects.toThrow(/failing closed/);

    // Half two: the post-spawn deliverCredentials push in the deploy path no
    // longer fires. A live push would have sent a "credentials-updated"
    // control frame to the child immediately after the ready handshake.
    const { router, spawns } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_grants-tourniquet@example.com");
    if (frame.workflow === undefined) throw new Error("unreachable");
    frame.workflow.credentials = {
      bindings: [
        {
          handle: "mcp:exa",
          credentialId: "cred_1",
          consumer: "tool:@corbits/mcp-tools",
        },
      ],
      materials: [
        {
          credentialId: "cred_1",
          providerKey: "http",
          origin: "https://mcp.exa.ai/mcp",
          secret: "unauthenticated-mcp-server",
        },
      ],
    };

    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const credentialsUpdatedLine = spawn.sentControlLines.find(
      (line) =>
        (JSON.parse(line) as { envelope: { payload: { type: string } } })
          .envelope.payload.type === "credentials-updated",
    );
    expect(credentialsUpdatedLine).toBeUndefined();
  });
});
