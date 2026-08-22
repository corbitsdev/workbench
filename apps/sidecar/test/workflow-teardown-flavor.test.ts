// `teardownDeployment` is the shared body behind `undeploy` (`reclaimDirs:
// true` -- forget the deployment entirely) and the state-preserving
// "hibernate" flavor (`reclaimDirs: false` -- tear the child down while
// keeping the deployment record and on-disk step state so a later `deploy`
// call for the same address resumes rather than starts fresh). No caller in
// this lane invokes the hibernate flavor yet -- the hub-side reap-and-relaunch
// flow that will is a separate lane -- so this suite drives it directly
// through the router's `teardownDeployment` method.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { IDLE_HIBERNATE_UNDEPLOY_REASON } from "@corbits/agent-lifecycle";

import { deriveDeploymentId } from "../src/workflow-host-wiring";
import { readWorkflowDeploymentRecord } from "../src/workflow-deployment-record";
import {
  answerReadyHandshake,
  makeLifecycleFixture,
  makeWorkflowFrame,
} from "./support/workflow-lifecycle-fixture";

describe("teardownDeployment reclaimDirs flavors", () => {
  test("reclaimDirs: true (undeploy) deletes the step-state dir and the deployment record", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_teardown-reclaim@example.com");
    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const recordFile = path.join(
      dataDir,
      "workflow-runs",
      deploymentId,
      "deployment.json",
    );
    const stepStateDir = path.join(
      dataDir,
      "workflow-step-state",
      deploymentId,
    );
    await fs.mkdir(stepStateDir, { recursive: true });
    await fs.writeFile(path.join(stepStateDir, "marker.txt"), "x");

    await router.teardownDeployment(frame.agentAddress, {
      reclaimDirs: true,
    });

    expect(spawn.killed).toBe(true);
    await expect(fs.stat(recordFile)).rejects.toThrow();
    await expect(fs.stat(stepStateDir)).rejects.toThrow();
    expect(router.activeAddresses()).toEqual([]);
  });

  test("reclaimDirs: false (hibernate) preserves the step-state dir and the deployment record", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_teardown-hibernate@example.com");
    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const recordFile = path.join(
      dataDir,
      "workflow-runs",
      deploymentId,
      "deployment.json",
    );
    const stepStateDir = path.join(
      dataDir,
      "workflow-step-state",
      deploymentId,
    );
    await fs.mkdir(stepStateDir, { recursive: true });
    await fs.writeFile(path.join(stepStateDir, "marker.txt"), "x");

    await router.teardownDeployment(frame.agentAddress, {
      reclaimDirs: false,
    });

    // The child is gone -- a hibernate still kills the process...
    expect(spawn.killed).toBe(true);
    // ...but every piece of durable state a relaunch resumes from survives.
    await expect(fs.stat(recordFile)).resolves.toBeDefined();
    await expect(fs.stat(stepStateDir)).resolves.toBeDefined();
    expect(
      await fs.readFile(path.join(stepStateDir, "marker.txt"), "utf8"),
    ).toBe("x");
    // The address is no longer live/routable: a relaunch re-establishes it
    // through the ordinary deploy path, not a resumed registration.
    expect(router.activeAddresses()).toEqual([]);

    // The kept record is stamped as parked -- the durable marker a boot
    // scan reads to tell "the hub parked this" from "this was live when
    // the process stopped".
    const record = await readWorkflowDeploymentRecord(dataDir, deploymentId);
    expect(record?.parkedAt).toBeDefined();
  });

  test("reclaimDirs: true (undeploy) never stamps a parked marker (the record is gone)", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_teardown-reclaim-no-mark@example.com");
    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const deploymentId = deriveDeploymentId(frame.agentAddress);
    await router.teardownDeployment(frame.agentAddress, {
      reclaimDirs: true,
    });

    await expect(
      readWorkflowDeploymentRecord(dataDir, deploymentId),
    ).resolves.toBeUndefined();
  });

  test("both flavors unregister the transport, routers, and deployment-address mapping", async () => {
    const { router, spawns, multistepMailRouter, multistepCredentialsRouter } =
      await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_teardown-unregister@example.com");
    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    await router.teardownDeployment(frame.agentAddress, {
      reclaimDirs: false,
    });

    // No live mail/credentials handler remains registered for the address:
    // routing a frame against it fails to find a handler.
    expect(
      multistepMailRouter.tryRoute(
        frame.agentAddress,
        new TextEncoder().encode("post-hibernate"),
      ),
    ).toBeNull();
    expect(
      await multistepCredentialsRouter.tryRoute({
        type: "credentials.update",
        agentAddress: frame.agentAddress,
        delivery: { bindings: [], materials: [] },
      }),
    ).toBe(false);
  });

  test("undeploy(frame) picks the flavor from frame.reason", async () => {
    const hibernating = await makeLifecycleFixture();
    const hibernateFrame = makeWorkflowFrame(
      "run_undeploy-reason-hibernate@example.com",
    );
    const hibernateDeploy = hibernating.router.deploy(hibernateFrame);
    await answerReadyHandshake(hibernating.spawns, 0);
    await hibernateDeploy;
    const hibernateDeploymentId = deriveDeploymentId(
      hibernateFrame.agentAddress,
    );
    const hibernateStepStateDir = path.join(
      hibernating.dataDir,
      "workflow-step-state",
      hibernateDeploymentId,
    );
    await fs.mkdir(hibernateStepStateDir, { recursive: true });

    await hibernating.router.undeploy?.({
      type: "agent.undeploy",
      agentAddress: hibernateFrame.agentAddress,
      reason: IDLE_HIBERNATE_UNDEPLOY_REASON,
    });

    // Tagged with the hub idle-reap's reason: preserved, not reclaimed.
    await expect(fs.stat(hibernateStepStateDir)).resolves.toBeDefined();

    const reclaiming = await makeLifecycleFixture();
    const reclaimFrame = makeWorkflowFrame(
      "run_undeploy-reason-reclaim@example.com",
    );
    const reclaimDeploy = reclaiming.router.deploy(reclaimFrame);
    await answerReadyHandshake(reclaiming.spawns, 0);
    await reclaimDeploy;
    const reclaimDeploymentId = deriveDeploymentId(reclaimFrame.agentAddress);
    const reclaimStepStateDir = path.join(
      reclaiming.dataDir,
      "workflow-step-state",
      reclaimDeploymentId,
    );
    await fs.mkdir(reclaimStepStateDir, { recursive: true });

    await reclaiming.router.undeploy?.({
      type: "agent.undeploy",
      agentAddress: reclaimFrame.agentAddress,
      reason: "channel-deleted",
    });

    // Any other reason still gets the destructive default.
    await expect(fs.stat(reclaimStepStateDir)).rejects.toThrow();
  });

  // CL-6644 part B: a hub-driven wake for a parked deployment is a fresh
  // `agent.deploy` for the same address, not a resume in place -- `0fd3fbc8`
  // deleted the sidecar-side in-place park/wake handler this used to be, and
  // a boot scan (CL-6282) skips a parked record entirely rather than
  // restoring it. Nothing sidecar-side ever resumes a parked deployment on
  // its own, so the wake's redeploy must complete cleanly against whatever
  // residue the parked record and its hibernate teardown left behind: the
  // deployment record still on disk (parked, not deleted), the slug
  // (`releaseSlug` only runs for a reclaiming teardown), and the step-state
  // dir the hibernate deliberately preserved. This proves that residue
  // never blocks the redeploy.
  test("deploy() after a hibernate teardown completes (a wake's redeploy for a parked address)", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_teardown-wake-redeploy@example.com");
    const firstDeploy = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await firstDeploy;

    await router.teardownDeployment(frame.agentAddress, {
      reclaimDirs: false,
    });

    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const parkedBeforeRedeploy = await readWorkflowDeploymentRecord(
      dataDir,
      deploymentId,
    );
    expect(parkedBeforeRedeploy?.parkedAt).toBeDefined();

    const secondDeploy = router.deploy(frame);
    await answerReadyHandshake(spawns, 1);
    await expect(secondDeploy).resolves.toBeDefined();

    expect(router.activeAddresses()).toEqual([frame.agentAddress]);
    const redeployedRecord = await readWorkflowDeploymentRecord(
      dataDir,
      deploymentId,
    );
    expect(redeployedRecord?.parkedAt).toBeUndefined();
  });
});
