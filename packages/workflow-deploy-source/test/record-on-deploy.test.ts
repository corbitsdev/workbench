// Pure unit test: proves the decorator records the deploy source AFTER a
// successful deploy, forwards the underlying result untouched, and never
// lets a recording failure fail the deploy call itself -- no DB, no
// SessionService, both are hand-rolled minimal doubles.
import { describe, expect, test } from "bun:test";
import type {
  AdoptingWorkflowDeployer,
  DeployWorkflowDefinitionResult,
  SessionService,
} from "@intx/hub-sessions";

import { withDeploySourceRecording } from "../src/record-on-deploy";
import type {
  WorkflowDeploySourceRecord,
  WorkflowDeploySourceStore,
} from "../src/store";

function fakeDeployer(): SessionService & AdoptingWorkflowDeployer {
  const result: DeployWorkflowDefinitionResult = {
    anchorRunId: "run_1",
    deploymentAddress: "run_1@tenant1.workbench.dev",
    publicKey: "pk_1",
  };
  return {
    stageWorkflowStep: async () => {},
    deployWorkflowFromSource: async () => result,
    deployAdoptedWorkflowFromSource: async () => result,
    sendUserMessage: async () => new Uint8Array(),
    endSession: async () => {},
  };
}

function recordingStore(): WorkflowDeploySourceStore & {
  recorded: WorkflowDeploySourceRecord[];
} {
  const recorded: WorkflowDeploySourceRecord[] = [];
  return {
    recorded,
    async record(entry) {
      recorded.push(entry);
    },
    async get() {
      return null;
    },
  };
}

const baseParams = {
  tenantId: "tenant_1",
  anchorRunId: "run_1",
  deploymentDomain: "tenant1.workbench.dev",
  agentAddress: "run_1@tenant1.workbench.dev",
  source: {
    kind: "asset" as const,
    assetId: "asset_1",
    package: { format: "source" as const, commitSha: "a".repeat(40) },
  },
  entry: "workflow.ts",
  definitionAssetId: "asset_1",
  config: {
    sessionId: "session_1",
    agentId: "agent_1",
    tenantId: "tenant_1",
    principalId: "principal_1",
    agentAddress: "run_1@tenant1.workbench.dev",
    systemPrompt: "",
    tools: [],
    grants: [],
    sources: [],
    defaultSource: "default",
  },
};

describe("withDeploySourceRecording", () => {
  test("records the source after deployWorkflowFromSource succeeds", async () => {
    const store = recordingStore();
    const wrapped = withDeploySourceRecording(fakeDeployer(), store);

    const result = await wrapped.deployWorkflowFromSource(baseParams);

    expect(result.anchorRunId).toBe("run_1");
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toEqual({
      anchorRunId: "run_1",
      tenantId: "tenant_1",
      deploymentDomain: "tenant1.workbench.dev",
      source: baseParams.source,
      entry: "workflow.ts",
      definitionAssetId: "asset_1",
      sourceAuthorityPrincipalId: "principal_1",
    });
  });

  test("records the source after deployAdoptedWorkflowFromSource succeeds", async () => {
    const store = recordingStore();
    const wrapped = withDeploySourceRecording(fakeDeployer(), store);

    await wrapped.deployAdoptedWorkflowFromSource({
      ...baseParams,
      pin: "1.2.3",
      sourceRef: "refs/heads/runs/run_1",
    });

    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]?.pin).toBe("1.2.3");
    expect(store.recorded[0]?.sourceRef).toBe("refs/heads/runs/run_1");
  });

  test("a recording failure is swallowed, not surfaced as a deploy failure", async () => {
    const failingStore: WorkflowDeploySourceStore = {
      record: async () => {
        throw new Error("db unreachable");
      },
      get: async () => null,
    };
    const wrapped = withDeploySourceRecording(fakeDeployer(), failingStore);

    const result = await wrapped.deployWorkflowFromSource(baseParams);
    expect(result.anchorRunId).toBe("run_1");
  });

  test("other SessionService methods pass through unwrapped", async () => {
    const store = recordingStore();
    const underlying = fakeDeployer();
    const wrapped = withDeploySourceRecording(underlying, store);

    expect(wrapped.stageWorkflowStep).toBe(underlying.stageWorkflowStep);
    expect(wrapped.sendUserMessage).toBe(underlying.sendUserMessage);
    expect(wrapped.endSession).toBe(underlying.endSession);
  });
});
