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

test("the step is unbounded: it re-arms after every reply instead of completing after the first", () => {
  // The platform's step primitive defaults `triggers` to 1 (batch). A
  // conversation is the long-lived interactive agent that must never
  // self-complete — without this, the run ends after the greeting and
  // every later message is rejected as sent to a terminal run.
  expect(assistantStep(buildAssistantWorkflow(INPUT)).triggers).toBe(
    "unbounded",
  );
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

test("the agent carries the tool package pins as declared", () => {
  const agent = assistantStep(buildAssistantWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual(ASSISTANT_TOOL_PACKAGE_PINS);
});

test("the workflow pins manus-tools and does not require a Manus credential binding", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(ASSISTANT_TOOL_PACKAGE_PINS.map((pin) => pin.name)).toContain(
    "@corbits/manus-tools",
  );
  expect(definition.credentialBindings ?? []).toEqual([]);
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

// CL-6179: on a stated outcome, Myra runs a short, bounded discovery
// interview before proposing anything — never the open-ended intake
// this clause exists to rule out.
test("the prompt runs discovery inside 'Deciding what to do', in order: interview, propose, build, hand off", () => {
  const decidingSection = ASSISTANT_SYSTEM_PROMPT.slice(
    ASSISTANT_SYSTEM_PROMPT.indexOf("## Deciding what to do"),
    ASSISTANT_SYSTEM_PROMPT.indexOf("## Being a teammate"),
  );

  const interviewAt = decidingSection.indexOf("ask one or two sharp questions");
  const proposeAt = decidingSection.indexOf(
    "propose a small, named specialist team",
  );
  const buildAt = decidingSection.indexOf("Build only on a light confirmation");
  const skillAt = decidingSection.indexOf("load the writing-system-prompts");
  const createAgentAt = decidingSection.indexOf("create_agent");
  const handoffAt = decidingSection.indexOf(
    "Their own chats for focused work.",
  );

  for (const at of [
    interviewAt,
    proposeAt,
    buildAt,
    skillAt,
    createAgentAt,
    handoffAt,
  ]) {
    expect(at).toBeGreaterThan(-1);
  }
  expect(interviewAt).toBeLessThan(proposeAt);
  expect(proposeAt).toBeLessThan(buildAt);
  // The skill loads before create_agent ever fires.
  expect(skillAt).toBeLessThan(createAgentAt);
  expect(createAgentAt).toBeLessThan(handoffAt);
});
