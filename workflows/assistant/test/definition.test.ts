// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  ASSISTANT_STEP_ID,
  ASSISTANT_SYSTEM_PROMPT,
  ASSISTANT_TOOL_PACKAGE_PINS,
  ASSISTANT_WORKFLOW_ID,
  buildAssistantWorkflow,
  serializeAssistantWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function assistantStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[ASSISTANT_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${ASSISTANT_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step, so a deployment stays conversational", () => {
  // A single-step deployment keeps one warm agent with durable memory
  // across runs; a second step would silently trade that memory away.
  // This assertion is the tripwire against that regression.
  const definition = buildAssistantWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([ASSISTANT_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([ASSISTANT_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(assistantStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(definition.id).toBe(ASSISTANT_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the assistant prompt, the preferences, and inlines no tools", () => {
  const agent = assistantStep(buildAssistantWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(ASSISTANT_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the prompt instructs Myra to greet, introduce herself, and ask what she's for on a bench's first-ever conversation", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("first message");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("greet the sender by name");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("introduce");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("Myra");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("standing job");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("one-off task");
});

test("the agent pins @corbits/memory-tools (CL-5852) — a real package name, resolved at deploy time", () => {
  const agent = assistantStep(buildAssistantWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual(ASSISTANT_TOOL_PACKAGE_PINS);
  expect(ASSISTANT_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/memory-tools", version: "0.0.1" },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildAssistantWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeAssistantWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: ASSISTANT_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [ASSISTANT_STEP_ID],
    steps: {
      assistant: {
        kind: "step",
        id: ASSISTANT_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: ASSISTANT_STEP_ID,
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeAssistantWorkflow(poisoned)).toThrow(
    /steps\.assistant\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildAssistantWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() => buildAssistantWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
  expect(() =>
    buildAssistantWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
