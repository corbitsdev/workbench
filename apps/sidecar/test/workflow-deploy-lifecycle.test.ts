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
} from "./support/workflow-lifecycle-fixture";

describe("workflow deployment lifecycle through the deploy router", () => {
  test("a deploy frame carrying referencedDefinitions materializes each body's workflow.json and sources.json", async () => {
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

    // The top-level definition lands where the workflow-process child's
    // loadWorkflowDefinition reads it...
    const assetDir = (id: string) =>
      path.join(dataDir, "assets", "workflow", id);
    const topLevel = JSON.parse(
      await fs.readFile(
        path.join(assetDir("wf-lifecycle"), "workflow.json"),
        "utf8",
      ),
    );
    expect(topLevel).toEqual(frame.workflow.definition);

    // ...and each referenced onTrigger body lands beside it under its own
    // ref -- the body id -- as the definition plus the co-located
    // per-step source pins the in-process body child resolves off disk.
    const bodyDir = assetDir(bodyDefinition.id);
    expect(
      JSON.parse(
        await fs.readFile(path.join(bodyDir, "workflow.json"), "utf8"),
      ),
    ).toEqual(bodyDefinition);
    expect(
      JSON.parse(await fs.readFile(path.join(bodyDir, "sources.json"), "utf8")),
    ).toEqual(bodySources);
  });

  test("a deploy frame carrying a referenced body's approvedWireHash threads REFERENCED_DEFINITION_HASHES to the spawned child and persists it for restore", async () => {
    const { router, spawns, dataDir } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-hashes@example.com");
    if (frame.workflow === undefined) throw new Error("unreachable");
    const bodyDefinition = {
      id: "wf-lifecycle-hashed-body",
      triggers: [{ type: "manual" }],
      stepOrder: ["body-step"],
      steps: { "body-step": { kind: "step" } },
    };
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
    frame.workflow.referencedDefinitions = [
      {
        definition: bodyDefinition,
        sources: bodySources,
        approvedWireHash: "sha256-approved-body-hash",
      },
    ];

    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    // The spawned child's env carries the approved hash keyed by the body's
    // definition id -- what `resolveVerifiedBody` in the workflow-host's
    // spawn-child adapter re-verifies a body spawn's recompute against.
    const referencedHashes = JSON.parse(
      spawn.env.REFERENCED_DEFINITION_HASHES ?? "{}",
    );
    expect(referencedHashes).toEqual({
      [bodyDefinition.id]: "sha256-approved-body-hash",
    });

    // ...and it survives a restart: the durable deployment record carries
    // the same map so a boot-time restore rebuilds the identical spawn env
    // without a hub round-trip.
    const recordFile = path.join(
      dataDir,
      "workflow-runs",
      deriveDeploymentId(frame.agentAddress),
      "deployment.json",
    );
    const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
    expect(record.referencedDefinitionHashes).toEqual({
      [bodyDefinition.id]: "sha256-approved-body-hash",
    });
  });

  test("a deploy frame with no referenced bodies threads an empty REFERENCED_DEFINITION_HASHES map", async () => {
    const { router, spawns } = await makeLifecycleFixture();
    const frame = makeWorkflowFrame("run_lifecycle-no-bodies@example.com");

    const deployPromise = router.deploy(frame);
    const spawn = await answerReadyHandshake(spawns, 0);
    await deployPromise;

    expect(JSON.parse(spawn.env.REFERENCED_DEFINITION_HASHES ?? "")).toEqual(
      {},
    );
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
