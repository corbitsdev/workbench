// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  CHANNEL_DIGEST_STEP_ID,
  CHANNEL_DIGEST_SYSTEM_PROMPT,
  CHANNEL_DIGEST_WORKFLOW_ID,
  buildChannelDigestWorkflow,
  serializeChannelDigestWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ch_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 60000,
} as const;

function digestStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[CHANNEL_DIGEST_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${CHANNEL_DIGEST_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildChannelDigestWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([CHANNEL_DIGEST_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([CHANNEL_DIGEST_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildChannelDigestWorkflow(INPUT);
  expect(digestStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildChannelDigestWorkflow(INPUT);
  expect(definition.id).toBe(CHANNEL_DIGEST_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent instructs relaying the exact summary line, carries the preferences, and inlines no tools", () => {
  const agent = digestStep(buildChannelDigestWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(CHANNEL_DIGEST_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildChannelDigestWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeChannelDigestWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: CHANNEL_DIGEST_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [CHANNEL_DIGEST_STEP_ID],
    steps: {
      "channel-digest": {
        kind: "step",
        id: CHANNEL_DIGEST_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: CHANNEL_DIGEST_STEP_ID,
          systemPrompt: CHANNEL_DIGEST_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeChannelDigestWorkflow(poisoned)).toThrow(
    /steps\.channel-digest\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildChannelDigestWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildChannelDigestWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildChannelDigestWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
