// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  DEFAULT_CALL_LIMIT,
  GRANOLA_CALL_CREDENTIAL_BINDINGS,
  GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
  GRANOLA_CALL_STEP_ID,
  GRANOLA_CALL_SYSTEM_PROMPT,
  GRANOLA_CALL_TOOL_PACKAGE_PINS,
  GRANOLA_CALL_WORKFLOW_ID,
  buildGranolaCallWorkflow,
  serializeGranolaCallWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function granolaCallStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[GRANOLA_CALL_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${GRANOLA_CALL_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildGranolaCallWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([GRANOLA_CALL_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([GRANOLA_CALL_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildGranolaCallWorkflow(INPUT);
  expect(granolaCallStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildGranolaCallWorkflow(INPUT);
  expect(definition.id).toBe(GRANOLA_CALL_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent instructs the pipeline, carries the preferences, and inlines no tools", () => {
  const agent = granolaCallStep(buildGranolaCallWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(GRANOLA_CALL_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the agent pins @corbits/granola-tools by name and version", () => {
  const agent = granolaCallStep(buildGranolaCallWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual([...GRANOLA_CALL_TOOL_PACKAGE_PINS]);
  expect(GRANOLA_CALL_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/granola-tools", version: "0.0.4" },
  ]);
});

test("the system prompt commits to the default call limit and an honest no-connection message", () => {
  expect(GRANOLA_CALL_SYSTEM_PROMPT).toContain(String(DEFAULT_CALL_LIMIT));
  expect(GRANOLA_CALL_SYSTEM_PROMPT.toLowerCase()).toContain(
    "never invent call counts",
  );
});

test("the system prompt names the status-report tool for a run that starts no children", () => {
  expect(GRANOLA_CALL_SYSTEM_PROMPT).toContain(
    GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
  );
  expect(GRANOLA_CALL_SYSTEM_PROMPT.toLowerCase()).toContain(
    "granola connector",
  );
});

test("the system prompt commits to skip-and-continue on a bad call, never blocking the batch", () => {
  expect(GRANOLA_CALL_SYSTEM_PROMPT.toLowerCase()).toContain(
    "skip only that call",
  );
});

test("the definition binds @corbits/granola-tools' declared handle to a tenant-owned granola credential", () => {
  const definition = buildGranolaCallWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual([
    ...GRANOLA_CALL_CREDENTIAL_BINDINGS,
  ]);
  expect(GRANOLA_CALL_CREDENTIAL_BINDINGS).toEqual([
    {
      package: "@corbits/granola-tools",
      handle: "granola",
      provider: "granola",
      locator: "tenant",
    },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildGranolaCallWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeGranolaCallWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: GRANOLA_CALL_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [GRANOLA_CALL_STEP_ID],
    steps: {
      [GRANOLA_CALL_STEP_ID]: {
        kind: "step",
        id: GRANOLA_CALL_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: GRANOLA_CALL_STEP_ID,
          systemPrompt: GRANOLA_CALL_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeGranolaCallWorkflow(poisoned)).toThrow(
    /steps\.granola-call\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildGranolaCallWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildGranolaCallWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildGranolaCallWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
