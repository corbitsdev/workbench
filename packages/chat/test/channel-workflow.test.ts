// Tests for this package's own contract: the shape `buildChannelWorkflow`
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here (mirrors workflows/echo's definition test).

import { expect, test } from "bun:test";
import type {
  ActionPrimitive,
  OnTriggerPrimitive,
  WorkflowDefinition,
} from "@intx/workflow";

import {
  CHANNEL_RELAY_HANDLER,
  CHANNEL_RELAY_STEP_ID,
  CHANNEL_SECTION_ID,
  CHANNEL_WORKFLOW_ID,
  buildChannelWorkflow,
  serializeChannelWorkflow,
} from "../src/channel-workflow";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  turnTimeoutMs: 600000,
} as const;

function section(definition: WorkflowDefinition): OnTriggerPrimitive {
  const primitive = definition.steps[CHANNEL_SECTION_ID];
  if (primitive === undefined || primitive.kind !== "onTrigger") {
    throw new Error(
      `definition has no onTrigger primitive named ${CHANNEL_SECTION_ID}`,
    );
  }
  return primitive;
}

function relayStep(definition: WorkflowDefinition): ActionPrimitive {
  const body = section(definition).body;
  if (!("inline" in body)) {
    throw new Error("expected an inline onTrigger body");
  }
  const primitive = body.inline.steps[CHANNEL_RELAY_STEP_ID];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `body has no action primitive named ${CHANNEL_RELAY_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one onTrigger section, so the run stays a single long-lived channel", () => {
  const definition = buildChannelWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([CHANNEL_SECTION_ID]);
  expect(Object.keys(definition.steps)).toEqual([CHANNEL_SECTION_ID]);
});

test("the section subscribes to mail at the channel's trigger address", () => {
  const definition = buildChannelWorkflow(INPUT);
  expect(definition.id).toBe(CHANNEL_WORKFLOW_ID);
  expect(section(definition).on).toEqual({
    type: "mail",
    to: INPUT.triggerAddress,
  });
  // The section's `on` is the sole trigger source: defineWorkflow
  // collects it into the workflow's own triggers.
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the relay body step is a deterministic action, never an agent step", () => {
  const step = relayStep(buildChannelWorkflow(INPUT));
  expect(step.kind).toBe("action");
  expect(step.handler).toBe(CHANNEL_RELAY_HANDLER);
  expect(step.effect).toEqual({ requires: ["mail:send"] });
  expect(step.timeout).toBe(INPUT.turnTimeoutMs);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildChannelWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeChannelWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: CHANNEL_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [CHANNEL_SECTION_ID],
    steps: {
      [CHANNEL_SECTION_ID]: {
        kind: "onTrigger",
        id: CHANNEL_SECTION_ID,
        on: { type: "mail", to: INPUT.triggerAddress },
        drainBehavior: "wait",
        body: {
          inline: {
            id: `${CHANNEL_WORKFLOW_ID}_${CHANNEL_SECTION_ID}`,
            triggers: [{ type: "manual" }],
            stepOrder: [CHANNEL_RELAY_STEP_ID],
            steps: {
              [CHANNEL_RELAY_STEP_ID]: {
                kind: "action",
                id: CHANNEL_RELAY_STEP_ID,
                handler: CHANNEL_RELAY_HANDLER,
                drainBehavior: "cancel",
                poisoned: () => undefined,
              },
            },
          },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeChannelWorkflow(poisoned)).toThrow(
    /steps\.inbound\.body\.inline\.steps\.relay\.poisoned/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() => buildChannelWorkflow({ ...INPUT, triggerAddress: "" })).toThrow(
    /triggerAddress/,
  );
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() => buildChannelWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
  expect(() => buildChannelWorkflow({ ...INPUT, turnTimeoutMs: 0.5 })).toThrow(
    /turnTimeoutMs/,
  );
});
