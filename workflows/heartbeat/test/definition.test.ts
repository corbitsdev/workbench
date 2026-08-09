// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  HEARTBEAT_STEP_ID,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_WORKFLOW_ID,
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 60000,
} as const;

function heartbeatStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[HEARTBEAT_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${HEARTBEAT_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildHeartbeatWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([HEARTBEAT_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([HEARTBEAT_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildHeartbeatWorkflow(INPUT);
  expect(heartbeatStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildHeartbeatWorkflow(INPUT);
  expect(definition.id).toBe(HEARTBEAT_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = heartbeatStep(buildHeartbeatWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(HEARTBEAT_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildHeartbeatWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeHeartbeatWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: HEARTBEAT_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [HEARTBEAT_STEP_ID],
    steps: {
      heartbeat: {
        kind: "step",
        id: HEARTBEAT_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: HEARTBEAT_STEP_ID,
          systemPrompt: HEARTBEAT_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeHeartbeatWorkflow(poisoned)).toThrow(
    /steps\.heartbeat\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildHeartbeatWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() => buildHeartbeatWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
  expect(() =>
    buildHeartbeatWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
