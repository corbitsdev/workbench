// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here. Whether a fired routine on this definition actually
// reaches `launchTask` instead of this step is
// `apps/hub/src/routine-launcher.test.ts`'s concern, not this
// package's — this package only proves it builds a valid, deployable
// definition.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  RECURRING_TASK_STEP_ID,
  RECURRING_TASK_SYSTEM_PROMPT,
  RECURRING_TASK_WORKFLOW_ID,
  buildRecurringTaskWorkflow,
  serializeRecurringTaskWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 60000,
} as const;

function recurringTaskStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[RECURRING_TASK_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${RECURRING_TASK_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildRecurringTaskWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([RECURRING_TASK_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([RECURRING_TASK_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildRecurringTaskWorkflow(INPUT);
  expect(recurringTaskStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildRecurringTaskWorkflow(INPUT);
  expect(definition.id).toBe(RECURRING_TASK_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = recurringTaskStep(buildRecurringTaskWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(RECURRING_TASK_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  expect(agent.toolFactories).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildRecurringTaskWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeRecurringTaskWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: RECURRING_TASK_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [RECURRING_TASK_STEP_ID],
    steps: {
      [RECURRING_TASK_STEP_ID]: {
        kind: "step",
        id: RECURRING_TASK_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: RECURRING_TASK_STEP_ID,
          systemPrompt: RECURRING_TASK_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeRecurringTaskWorkflow(poisoned)).toThrow(
    /steps\.recurring-task\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildRecurringTaskWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildRecurringTaskWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildRecurringTaskWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
