import { describe, expect, test } from "bun:test";

import type { HarnessConfig } from "@intx/types/runtime";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import {
  deriveStepAgentId,
  resolveStepAddress,
} from "@intx/workflow-deploy";

import type { DeployContent } from "./agent-repo";
import { preparedStepStageArgs } from "./session-service";
import type { AllocatedSidecarTarget } from "./ws/sidecar-handler";

const pins: readonly ToolPackagePin[] = [
  { name: "acme-tool", version: "^1.2.3" },
];

function baseArgs() {
  return {
    anchorRunId: "run_1",
    deploymentDomain: "example.test",
    stepId: "step-a",
    stepCount: 2,
    config: { marker: "config" } as unknown as HarnessConfig,
    deployContent: { systemPrompt: "prompt" } satisfies DeployContent,
    allocationTarget: { marker: "target" } as unknown as AllocatedSidecarTarget,
  };
}

describe("preparedStepStageArgs — corbitsdev/workbench#709 prepared-path pins", () => {
  test("forwards toolPackagePins verbatim when present", () => {
    const base = baseArgs();
    const args = preparedStepStageArgs({ ...base, toolPackagePins: pins });

    expect(args.toolPackagePins).toBe(pins);
  });

  test("leaves address, agent id, and passthrough fields untouched", () => {
    const base = baseArgs();
    const args = preparedStepStageArgs({ ...base, toolPackagePins: pins });

    expect(args.agentAddress).toBe(
      resolveStepAddress({
        runId: base.anchorRunId,
        stepId: base.stepId,
        domain: base.deploymentDomain,
        stepCount: base.stepCount,
      }),
    );
    expect(args.agentId).toBe(
      deriveStepAgentId({ runId: base.anchorRunId, stepId: base.stepId }),
    );
    expect(args.runId).toBe(base.anchorRunId);
    expect(args.config).toBe(base.config);
    expect(args.deployContent).toBe(base.deployContent);
    expect(args.allocationTarget).toBe(base.allocationTarget);
  });

  test("omits the key when pins are undefined so the empty/undefined skip holds", () => {
    const args = preparedStepStageArgs(baseArgs());

    expect("toolPackagePins" in args).toBe(false);
  });

  test("forwards an empty array as-is (stageWorkflowStep treats empty as skip)", () => {
    const empty: readonly ToolPackagePin[] = [];
    const args = preparedStepStageArgs({
      ...baseArgs(),
      toolPackagePins: empty,
    });

    expect(args.toolPackagePins).toBe(empty);
  });
});
