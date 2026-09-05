// Proves this definition's tool-package pins are on the live
// `AgentDefinition` a native provisioned deploy renders from — not a
// folded-run launch body.
import { expect, test } from "bun:test";

import {
  MORNING_BRIEF_STEP_ID,
  MORNING_BRIEF_TOOL_PACKAGE_PINS,
  buildMorningBriefWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "morning-brief@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120000,
} as const;

test("a workflow built from this definition carries its tool-package pins on the agent step", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  const step = definition.steps[MORNING_BRIEF_STEP_ID];
  expect(step?.kind).toBe("step");
  expect(step?.kind === "step" ? step.agent.toolPackagePins : undefined).toEqual(
    [...MORNING_BRIEF_TOOL_PACKAGE_PINS],
  );
});

test("the workflow declares exactly one step", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(Object.keys(definition.steps)).toEqual([MORNING_BRIEF_STEP_ID]);
});
