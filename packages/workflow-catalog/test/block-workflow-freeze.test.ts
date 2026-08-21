// CL-6439: the template-block deploy freezes its serialized definition
// through @corbits/workflow-freeze (the hub's `deployWorkflowSource`
// binding calls `freezeInertWorkflowDefinition`), so a webhook-fired
// launch reads a real frozen wire projection instead of 500ing with
// DefinitionProjectionMissingError. This suite locks the freezability
// of every block source `buildBlockWorkflowSource` can answer: a block
// edit that names an unresolvable director or an unprojectable step
// would turn the deploy route into a 500, and must fail here first.
import { describe, expect, test } from "bun:test";

import { projectAndWalkInertDefinition } from "@corbits/workflow-freeze";

import { buildBlockWorkflowSource } from "../src/block-workflows";

const BUILD_INPUT = {
  tenantDomain: "acme.workbench.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-5" }],
} as const;

describe("code-review block source freezes", () => {
  test("projects, hashes, and walks with no unresolved directors", async () => {
    const source = buildBlockWorkflowSource("code-review", BUILD_INPUT);
    if (source === undefined) throw new Error("no code-review block source");

    const frozen = await projectAndWalkInertDefinition(source.workflowJson);

    expect(frozen.wireHash).not.toBe("");
    const definition = JSON.parse(source.workflowJson) as {
      stepOrder: string[];
    };
    expect(Object.keys(frozen.projection.steps).sort()).toEqual(
      [...definition.stepOrder].sort(),
    );
  });

  test("freeze reports the github tool grant the launch will gate on", async () => {
    const source = buildBlockWorkflowSource("code-review", BUILD_INPUT);
    if (source === undefined) throw new Error("no code-review block source");

    const frozen = await projectAndWalkInertDefinition(source.workflowJson);

    expect(frozen.grants.length).toBeGreaterThan(0);
    expect(frozen.grantSnapshot.perStep.length).toBeGreaterThan(0);
  });
});
