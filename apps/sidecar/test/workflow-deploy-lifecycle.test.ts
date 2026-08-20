// Workflow deployment lifecycle through OUR wiring: an accepted
// workflow frame spawns a supervised child and becomes addressable; the
// process-exit drain (`shutdownAll`) kills the child but preserves every
// piece of durable state a later boot restores from; `undeploy` reclaims
// the deployment's records and per-step scratch while the durable
// conversation root survives BOTH -- it is never deleted, so a re-deploy
// on the same address resumes the prior conversation. Supervisor
// scheduling and child IPC internals are the published packages'
// concern and are not re-proven here; the mock spawner below stands in
// for the child, completing only the signed ready handshake the
// supervisor requires.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { deriveDeploymentId } from "../src/workflow-host-wiring";
import {
  answerReadyHandshake,
  makeLifecycleFixture,
  makeWorkflowFrame,
  LIFECYCLE_APPROVED_WIRE_HASH,
} from "./support/workflow-lifecycle-fixture";

describe("workflow deployment lifecycle through the deploy router", () => {
  test("a deploy frame carrying referencedDefinitions stages each body's sources.json and no body definition", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-bodies@example.com");
    if (frame.workflow === undefined) throw new Error("unreachable");
    const bodySources = {
      "body-step": [
        {
          id: "body-step",
          provider: "anthropic",
          baseURL: "https://api.anthropic.com",
          apiKey: "sk-body",
          model: "claude-3-5",
        },
      ],
    };
    const bodyDefinition = {
      id: "wf-lifecycle-body",
      triggers: [{ type: "manual" }],
      stepOrder: ["body-step"],
      steps: { "body-step": { kind: "step" } },
    };
    frame.workflow.referencedDefinitions = [
      { definition: bodyDefinition, sources: bodySources },
    ];

    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    await deployPromise;

    // A body child runs in-process and loses its env across a restart, so its
    // per-step source pins must be durable on disk.
    const bodyDir = path.join(dataDir, "assets", "workflow", bodyDefinition.id);
    expect(
      JSON.parse(await fs.readFile(path.join(bodyDir, "sources.json"), "utf8")),
    ).toEqual(bodySources);

    // The body DEFINITION is never staged: the run child resolves each body
    // in-memory from the parent's re-verified closure. A staged copy would be
    // a second, un-verified source of the body's bytes.
    await expect(
      fs.stat(path.join(bodyDir, "workflow.json")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(dataDir, "assets", "workflow", "wf-lifecycle")),
    ).rejects.toThrow();
  });

  test("a deploy threads the materialized closure dir and the hub-approved hash to the child, and persists the pin for restore", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-closure@example.com");

    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const deploymentId = deriveDeploymentId(frame.agentAddress);
    // The child EVALUATES the pinned code from this dir rather than reading an
    // inert definition off disk, and re-verifies its projection against the
    // hub-approved hash -- never a sidecar recompute.
    expect(spawn.env.CLOSURE_PACKAGE_DIR).toBe(
      path.join(dataDir, "closure-package", deploymentId),
    );
    expect(spawn.env.DEFINITION_HASH).toBe(LIFECYCLE_APPROVED_WIRE_HASH);
    expect(spawn.env.WORKFLOW_DEFINITION_REF).toBeUndefined();
    expect(spawn.env.REFERENCED_DEFINITION_HASHES).toBeUndefined();

    // The record carries what a boot-time restore needs to re-materialize the
    // same closure and re-verify it against the same anchor.
    const record = JSON.parse(
      await fs.readFile(
        path.join(dataDir, "workflow-runs", deploymentId, "deployment.json"),
        "utf8",
      ),
    );
    expect(record.approvedWireHash).toBe(LIFECYCLE_APPROVED_WIRE_HASH);
    expect(record.sourceRef.source).toEqual({
      kind: "registry",
      registry: "npm",
    });
  });

  test("a workflow frame is accepted: the child spawns, the address goes live, and a durable record lands", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-accept@example.com");

    const deployPromise = router.deploy(frame);
    await answerReadyHandshake(spawns, 0);
    const result = await deployPromise;

    // The ack carries the supervisor principal's verifying key.
    expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // The deployment is addressable: the boot edge announces exactly
    // this set to the hub on every (re)connect.
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);
    // The durable deployment record the next boot restores from.
    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const recordFile = path.join(
      dataDir,
      "workflow-runs",
      deploymentId,
      "deployment.json",
    );
    await expect(fs.stat(recordFile)).resolves.toBeDefined();
  });

  test("shutdownAll drains the child but preserves the deployment record and conversation root", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-drain@example.com");
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
    const durableConversationFile = path.join(
      dataDir,
      "agent-conversation-state",
      deploymentId,
      encodeURIComponent("step-1"),
      "checkpoint.json",
    );
    await fs.mkdir(path.dirname(durableConversationFile), { recursive: true });
    await fs.writeFile(durableConversationFile, "x");

    await router.shutdownAll();

    // The child is gone and the address is no longer announced...
    expect(spawn.killed).toBe(true);
    expect(spawn.exitedResolved).toBe(true);
    expect(router.activeAddresses()).toEqual([]);
    // ...but every durable restore source survives: the record the next
    // boot's restore re-spawns from, and the conversation the respawned
    // warm agent resumes.
    await expect(fs.stat(recordFile)).resolves.toBeDefined();
    expect(await fs.readFile(durableConversationFile, "utf8")).toBe("x");
  });

  test("undeploy kills the child, reclaims scratch and record, and never deletes the conversation root", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-undeploy@example.com");
    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    expect(spawn.killed).toBe(false);
    expect(spawn.exitedResolved).toBe(false);

    const undeploy = router.undeploy;
    if (undeploy === undefined) {
      throw new Error("router.undeploy is undefined");
    }

    // Pre-seed the on-disk per-step scratch the child roots under
    // `<dataDir>/workflow-step-state/<deploymentId>/` and the durable
    // conversation under `<dataDir>/agent-conversation-state/<deploymentId>/`.
    // The warm subtree is the stable per-agent workspace (one dir, not
    // one-per-message); a stale cold `runs/<runId>/` subtree models a
    // multi-step leftover the per-run cleanup did not drop. An unrelated
    // deployment's step-state subtree must survive the undeploy sweep.
    const deploymentId = deriveDeploymentId(frame.agentAddress);
    const stepStateRoot = path.join(dataDir, "workflow-step-state");
    const warmWorkspaceFile = path.join(
      stepStateRoot,
      deploymentId,
      "warm",
      encodeURIComponent("step-1"),
      "workspace",
      "notes.txt",
    );
    const coldLeftoverFile = path.join(
      stepStateRoot,
      deploymentId,
      "runs",
      "run-stale",
      "steps",
      "step-1",
      "attempt-1",
      "workspace",
      "scratch.txt",
    );
    const otherDeploymentFile = path.join(
      stepStateRoot,
      "other-deployment",
      "warm",
      "step-1",
      "workspace",
      "keep.txt",
    );
    const durableConversationFile = path.join(
      dataDir,
      "agent-conversation-state",
      deploymentId,
      encodeURIComponent("step-1"),
      "checkpoint.json",
    );
    for (const file of [
      warmWorkspaceFile,
      coldLeftoverFile,
      otherDeploymentFile,
      durableConversationFile,
    ]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "x");
    }

    await undeploy({
      type: "agent.undeploy",
      agentAddress: frame.agentAddress,
      reason: "test undeploy",
    });

    expect(spawn.killed).toBe(true);
    expect(spawn.exitedResolved).toBe(true);
    expect(router.activeAddresses()).toEqual([]);

    // The deployment's whole step-state subtree is reclaimed -- warm
    // stable workspace AND any cold leftover -- now that its supervisor
    // and child are torn down.
    await expect(
      fs.stat(path.join(stepStateRoot, deploymentId)),
    ).rejects.toThrow();
    // So is the deployment record: an undeployed deployment must not be
    // restored on the next boot.
    await expect(
      fs.stat(
        path.join(dataDir, "workflow-runs", deploymentId, "deployment.json"),
      ),
    ).rejects.toThrow();
    // A different deployment's scratch is untouched: the sweep is scoped
    // to this deployment's `<deploymentId>` subtree only.
    expect(await fs.readFile(otherDeploymentFile, "utf8")).toBe("x");
    // The durable conversation lives under a DIFFERENT root and must
    // survive so a re-deploy restores the prior conversation.
    expect(await fs.readFile(durableConversationFile, "utf8")).toBe("x");
  });

  // CL-6192: the hub's `credentials.update` frame (a rotation, or a
  // revocation) must reach the resident workflow-process child. Before this
  // port, no `MultistepCredentialsRouter` handler was ever installed, so an
  // inbound `credentials.update` frame was unrouted for every deployment.
  test("a hub credentials.update frame reaches the child as a credentials-updated control frame", async () => {
    const { router, spawns, multistepCredentialsRouter } =
      await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-credentials@example.com");

    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    const delivery = {
      bindings: [
        {
          handle: "mcp.exa",
          credentialId: "cred_1",
          consumer: "tool:@corbits/mcp-tools",
        },
      ],
      materials: [
        {
          credentialId: "cred_1",
          providerKey: "http",
          origin: "https://mcp.exa.ai/mcp",
          secret: "rotated-secret",
        },
      ],
    };

    const routed = await multistepCredentialsRouter.tryRoute({
      type: "credentials.update",
      agentAddress: frame.agentAddress,
      delivery,
    });

    expect(routed).toBe(true);
    const credentialsUpdatedLine = spawn.sentControlLines.find(
      (line) =>
        (JSON.parse(line) as { envelope: { payload: { type: string } } })
          .envelope.payload.type === "credentials-updated",
    );
    if (credentialsUpdatedLine === undefined) {
      throw new Error(
        "expected a credentials-updated control frame after routing credentials.update",
      );
    }
    const parsed = JSON.parse(credentialsUpdatedLine) as {
      envelope: { payload: { type: string; data: { delivery: unknown } } };
    };
    expect(parsed.envelope.payload.data.delivery).toEqual(delivery);
  });
});
