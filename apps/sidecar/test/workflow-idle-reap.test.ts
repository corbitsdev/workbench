// CL-5477/CL-5480 idle reap: park an idle deployment's workflow-child to
// reclaim its memory while keeping its identity, anchor, and routability
// intact -- the persisted deployment record, slug claim, and step-state
// scratch survive a park untouched, and the address stays announced
// (`activeAddresses()`) so the hub keeps routing its mail here. A parked
// deployment wakes (respawns from its record) on its next inbound frame,
// re-dispatching the SAME frame into the freshly-live handler.
//
// Ported from upstream Interchange's sidecar
// (apps/sidecar/src/workflow-host-wiring.ts, CL-5477 "idle reap: park /
// wake / sweep" and CL-5480 "restore-as-parked"), adapted to this
// directory's split (`workflow-host-wiring/index.ts` + `supervisor.ts`)
// and to this sidecar's additional `MultistepCredentialsRouter`, which has
// no scout counterpart and gets the same wake-then-redispatch treatment as
// mail/signal/sources here.
//
// NOT covered here: "the sweep skips a deployment with an open run." The
// open-run guard (`openRuns`) is populated by a `RepoStore` wrapper
// (`createRunTrackingRepoStore`) that watches the supervisor's OWN
// `writeTreePreservingPrefix` calls for `runs/<runId>/events/` commits --
// driving one for real requires simulating an actual trigger-fire round
// trip through the mock child's wire protocol, which this fixture's
// ready-handshake-only mock does not model. The mechanism is exercised by
// code inspection (mirrors scout's `createRunTrackingRepoStore` verbatim)
// but has no automated regression test in this pass.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deriveDeploymentId } from "../src/workflow-host-wiring";
import { materializeWorkflowJson } from "../src/workflow-host-wiring/asset-materialization";
import {
  writeWorkflowDeploymentActivityMarker,
  writeWorkflowDeploymentRecord,
} from "../src/workflow-deployment-record";
import {
  answerReadyHandshake,
  makeLifecycleFixture,
  makeWorkflowFrame,
} from "./support/workflow-lifecycle-fixture";

/** Poll `check` until it returns true or `timeoutMs` elapses. */
async function waitFor(
  check: () => boolean,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * Hand-construct the on-disk state a prior sidecar process's deploy would
 * have left behind for a single-step deployment: the deployment record,
 * the workflow definition asset, and the durable activity marker. Used by
 * the boot-restore tests so they exercise `restoreWorkflowDeployments`
 * against a fresh `dataDir` with no live router (and no background
 * dispatch-retry noise from this fixture's incomplete mock RepoStore) ever
 * having touched it.
 */
async function seedOnDiskDeployment(opts: {
  agentAddress: string;
  activityMs: number;
}): Promise<{ dataDir: string; deploymentId: string }> {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sidecar-idle-reap-seed-"),
  );
  const frame = makeWorkflowFrame(opts.agentAddress);
  if (frame.workflow === undefined) throw new Error("unreachable");
  const deploymentId = deriveDeploymentId(opts.agentAddress);

  await materializeWorkflowJson(dataDir, frame.workflow.definition);
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, {
    version: 1,
    agentAddress: opts.agentAddress,
    definitionId: frame.workflow.definition.id,
    sources: frame.workflow.sources,
    hubPublicKey: frame.hubPublicKey,
  });
  await writeWorkflowDeploymentActivityMarker(
    dataDir,
    deploymentId,
    opts.activityMs,
  );
  return { dataDir, deploymentId };
}

describe("CL-5477 idle reap: park / wake / sweep", () => {
  test("the idle sweep parks a deployment past the reap window, keeping its record and slug while tearing the child down", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture({
      idleReapMs: 50,
    });
    const frame = makeWorkflowFrame("run_idle-park@example.com");
    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    expect(spawn.killed).toBe(false);
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);

    // The sweep runs at a quarter of the threshold, clamped to a 1s floor,
    // so a 50ms threshold still sweeps within ~1.1s.
    await waitFor(() => spawn.killed, 3000);

    // The child is gone...
    expect(spawn.killed).toBe(true);
    // ...but the address is STILL announced: the hub must keep routing its
    // mail here so the wake handlers can respawn it.
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);

    // Park does not touch the deployment record or the slug: both survive
    // on disk exactly as the live deploy left them.
    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const recordFile = path.join(
      dataDir,
      "workflow-runs",
      deploymentId,
      "deployment.json",
    );
    await expect(fs.stat(recordFile)).resolves.toBeDefined();
  });

  test("parked mail wakes the deployment and re-dispatches the same frame into the freshly-live handler", async () => {
    const { router, spawns, dataDir, multistepMailRouter } =
      await makeLifecycleFixture({ idleReapMs: 50 });
    const frame = makeWorkflowFrame("run_idle-wake-mail@example.com");
    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    await waitFor(() => spawns[0]?.killed === true, 3000);
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);
    expect(spawns).toHaveLength(1);

    // An inbound mail frame against the parked address should wake it (a
    // second child spawns from the persisted record) and then re-dispatch
    // this SAME message into the newly-live mail handler.
    const message = new TextEncoder().encode("hello-after-park");
    const routePromise = multistepMailRouter.tryRoute(
      frame.agentAddress,
      message,
    );
    await answerReadyHandshake(spawns, 1);
    await routePromise;

    expect(spawns).toHaveLength(2);
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);

    // The record is untouched by the wake -- restore reads it, never
    // rewrites it.
    const deploymentId = deriveDeploymentId(frame.agentAddress);
    await expect(
      fs.stat(
        path.join(dataDir, "workflow-runs", deploymentId, "deployment.json"),
      ),
    ).resolves.toBeDefined();
  });

  test("concurrent wakes for one address share a single respawn (single-flight)", async () => {
    const { router, spawns, multistepSignalRouter } =
      await makeLifecycleFixture({ idleReapMs: 50 });
    const frame = makeWorkflowFrame("run_idle-wake-singleflight@example.com");
    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    await waitFor(() => spawns[0]?.killed === true, 3000);

    // Two concurrent signal frames against the parked address both trigger
    // `ensureAwake`; only one respawn should occur.
    const first = multistepSignalRouter.tryRoute({
      type: "signal.deliver",
      agentAddress: frame.agentAddress,
      runId: "run-1",
      signalName: "sig",
      signalId: "sig-1",
      payload: null,
    });
    const second = multistepSignalRouter.tryRoute({
      type: "signal.deliver",
      agentAddress: frame.agentAddress,
      runId: "run-1",
      signalName: "sig",
      signalId: "sig-2",
      payload: null,
    });
    await answerReadyHandshake(spawns, 1);
    await Promise.all([first, second]);

    // Exactly one wake respawn, not two.
    expect(spawns).toHaveLength(2);
  });

  test("boot restores a deployment whose activity marker is stale beyond the reap window as parked, spawning no process", async () => {
    // Hand-construct the on-disk state a prior process's deploy would have
    // left behind, rather than deploying live first: a live deploy's
    // deployment shares this fixture's `dataDir` with a background
    // dispatch-retry loop the mock RepoStore stub never satisfies
    // (`writeTreeDelta not implemented for this test`), and that loop
    // keeps re-touching the activity marker after `shutdownAll()` --
    // racing this test's own backdate. Building the on-disk state directly
    // sidesteps that entirely and asserts exactly the boot-scan behavior
    // under test: what `restoreWorkflowDeployments` does with a record
    // whose marker is already stale.
    const { dataDir } = await seedOnDiskDeployment({
      agentAddress: "run_idle-boot-stale@example.com",
      activityMs: Date.now() - 2 * 60 * 60 * 1000,
    });

    const restarted = await makeLifecycleFixture({
      idleReapMs: 60 * 60_000,
      dataDir,
    });
    await restarted.router.restoreWorkflowDeployments();

    // The address is announced (a parked deployment is still routable)...
    expect(restarted.router.activeAddresses()).toEqual([
      "run_idle-boot-stale@example.com",
    ]);
    // ...but restoring it spawned NO process: this is the CL-6255 boot
    // storm fix.
    expect(restarted.spawns).toHaveLength(0);
  });

  test("boot restores a deployment with a fresh activity marker live, spawning its process", async () => {
    const { dataDir } = await seedOnDiskDeployment({
      agentAddress: "run_idle-boot-fresh@example.com",
      activityMs: Date.now(),
    });

    const restarted = await makeLifecycleFixture({
      idleReapMs: 60 * 60_000,
      dataDir,
    });
    const restorePromise = restarted.router.restoreWorkflowDeployments();
    await answerReadyHandshake(restarted.spawns, 0);
    await restorePromise;

    expect(restarted.router.activeAddresses()).toEqual([
      "run_idle-boot-fresh@example.com",
    ]);
    expect(restarted.spawns).toHaveLength(1);
  });

  test("undeploy settles an in-flight wake before tearing the deployment down", async () => {
    const { router, spawns, dataDir, multistepMailRouter } =
      await makeLifecycleFixture({ idleReapMs: 50 });
    const frame = makeWorkflowFrame(
      "run_idle-undeploy-settles-wake@example.com",
    );
    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    await waitFor(() => spawns[0]?.killed === true, 3000);

    // Kick off a wake (via inbound mail) but do NOT answer its ready
    // handshake yet -- the wake is now in flight.
    const message = new TextEncoder().encode("racing-undeploy");
    const wakeRoutePromise = multistepMailRouter.tryRoute(
      frame.agentAddress,
      message,
    );

    // Undeploy races the in-flight wake. It must await the wake settling
    // (successfully or not) before it tears the address's routing state
    // down, so it never resurrects an orphaned post-undeploy spawn.
    const undeploy = router.undeploy;
    if (undeploy === undefined) throw new Error("router.undeploy is undefined");
    const undeployPromise = undeploy({
      type: "agent.undeploy",
      agentAddress: frame.agentAddress,
      reason: "test undeploy racing a wake",
    });

    // Answer the wake's respawn so it can settle.
    await answerReadyHandshake(spawns, 1);
    await Promise.allSettled([wakeRoutePromise, undeployPromise]);
    await undeployPromise;

    // Undeploy always wins: the deployment ends up fully torn down with no
    // record left to restore, and the address is no longer announced --
    // regardless of how the raced wake resolved.
    expect(router.activeAddresses()).toEqual([]);
    const deploymentId = deriveDeploymentId(frame.agentAddress);
    await expect(
      fs.stat(
        path.join(dataDir, "workflow-runs", deploymentId, "deployment.json"),
      ),
    ).rejects.toThrow();
  });
});
