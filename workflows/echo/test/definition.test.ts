// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  ECHO_STEP_ID,
  ECHO_SYSTEM_PROMPT,
  ECHO_WORKFLOW_ID,
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function echoStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[ECHO_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(`definition has no step primitive named ${ECHO_STEP_ID}`);
  }
  return primitive;
}

test("the definition has exactly one step, so a deployment stays conversational", () => {
  // A single-step deployment keeps one warm agent with durable memory
  // across runs; a second step would silently trade that memory away.
  // This assertion is the tripwire against that regression.
  const definition = buildEchoWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([ECHO_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([ECHO_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildEchoWorkflow(INPUT);
  expect(echoStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildEchoWorkflow(INPUT);
  expect(definition.id).toBe(ECHO_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent instructs echoing, carries the preferences, and inlines no tools", () => {
  const agent = echoStep(buildEchoWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(ECHO_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildEchoWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeEchoWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: ECHO_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [ECHO_STEP_ID],
    steps: {
      echo: {
        kind: "step",
        id: ECHO_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: ECHO_STEP_ID,
          systemPrompt: ECHO_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeEchoWorkflow(poisoned)).toThrow(
    /steps\.echo\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() => buildEchoWorkflow({ ...INPUT, triggerAddress: "" })).toThrow(
    /triggerAddress/,
  );
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() => buildEchoWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
  expect(() => buildEchoWorkflow({ ...INPUT, turnTimeoutMs: 0.5 })).toThrow(
    /turnTimeoutMs/,
  );
});
