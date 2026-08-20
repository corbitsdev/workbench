// Tests for this package's own contract: the shape
// `buildWorkbenchHostWorkflow` commits to, its serialization guarantees,
// and its boundary. The platform's own normalization, model
// resolution, and launch machinery are its business, not re-proven
// here (mirrors `workflows/echo`'s definition test, whose shape this
// definition now shares).

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  WORKBENCH_HOST_STEP_ID,
  WORKBENCH_HOST_SYSTEM_PROMPT,
  WORKBENCH_HOST_WORKFLOW_ID,
  buildWorkbenchHostWorkflow,
  serializeWorkbenchHostWorkflow,
} from "../src/workbench-workflow";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  turnTimeoutMs: 600000,
} as const;

function hostStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[WORKBENCH_HOST_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${WORKBENCH_HOST_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step, so the run stays a single long-lived workbench", () => {
  const definition = buildWorkbenchHostWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([WORKBENCH_HOST_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([WORKBENCH_HOST_STEP_ID]);
});

test("the definition is triggered by mail to the workbench's address", () => {
  const definition = buildWorkbenchHostWorkflow(INPUT);
  expect(definition.id).toBe(WORKBENCH_HOST_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the step carries an explicit per-occurrence timeout", () => {
  const definition = buildWorkbenchHostWorkflow(INPUT);
  expect(hostStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the agent carries the anchor system prompt and inlines no tools", () => {
  const agent = hostStep(buildWorkbenchHostWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(WORKBENCH_HOST_SYSTEM_PROMPT);
  expect(agent.toolFactories).toEqual([]);
  expect(agent.capabilities).toEqual([]);
});

test("inference preferences default to empty when omitted, since the anchor never performs inference", () => {
  const agent = hostStep(buildWorkbenchHostWorkflow(INPUT)).agent;
  expect(agent.inference.sources).toEqual([]);
});

test("inference preferences are carried through when provided", () => {
  const agent = hostStep(
    buildWorkbenchHostWorkflow({
      ...INPUT,
      inferencePreferences: [
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
    }),
  ).agent;
  expect(agent.inference.sources).toEqual([
    { provider: "anthropic", model: "claude-sonnet-5" },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildWorkbenchHostWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeWorkbenchHostWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: WORKBENCH_HOST_WORKFLOW_ID,
    triggers: [{ type: "mail", to: INPUT.triggerAddress }],
    stepOrder: [WORKBENCH_HOST_STEP_ID],
    steps: {
      [WORKBENCH_HOST_STEP_ID]: {
        kind: "step",
        id: WORKBENCH_HOST_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: WORKBENCH_HOST_STEP_ID,
          systemPrompt: WORKBENCH_HOST_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeWorkbenchHostWorkflow(poisoned)).toThrow(
    /steps\.host\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildWorkbenchHostWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildWorkbenchHostWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildWorkbenchHostWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
