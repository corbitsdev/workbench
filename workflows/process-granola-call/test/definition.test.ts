// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  PROCESS_GRANOLA_CALL_CREDENTIAL_BINDINGS,
  PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
  PROCESS_GRANOLA_CALL_STEP_ID,
  PROCESS_GRANOLA_CALL_SYSTEM_PROMPT,
  PROCESS_GRANOLA_CALL_TOOL_PACKAGE_PINS,
  PROCESS_GRANOLA_CALL_WORKFLOW_ID,
  buildProcessGranolaCallWorkflow,
  serializeProcessGranolaCallWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000001@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function processStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[PROCESS_GRANOLA_CALL_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${PROCESS_GRANOLA_CALL_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildProcessGranolaCallWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([PROCESS_GRANOLA_CALL_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([PROCESS_GRANOLA_CALL_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildProcessGranolaCallWorkflow(INPUT);
  expect(processStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildProcessGranolaCallWorkflow(INPUT);
  expect(definition.id).toBe(PROCESS_GRANOLA_CALL_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent instructs the five-section extraction, carries the preferences, and inlines no tools", () => {
  const agent = processStep(buildProcessGranolaCallWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(PROCESS_GRANOLA_CALL_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  expect(agent.toolFactories).toEqual([]);
  for (const section of [
    "Participants",
    "Summary",
    "Pain points",
    "Decisions",
    "Action items",
  ]) {
    expect(PROCESS_GRANOLA_CALL_SYSTEM_PROMPT).toContain(section);
  }
});

test("the agent pins @corbits/granola-tools by name and version", () => {
  const agent = processStep(buildProcessGranolaCallWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual([
    ...PROCESS_GRANOLA_CALL_TOOL_PACKAGE_PINS,
  ]);
  expect(PROCESS_GRANOLA_CALL_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/granola-tools", version: "0.0.4" },
  ]);
});

test("the system prompt commits to an honest failure instead of a fabricated document", () => {
  const lowered = PROCESS_GRANOLA_CALL_SYSTEM_PROMPT.toLowerCase();
  expect(lowered).toContain("do not fabricate call notes");
  expect(lowered).toContain("never a fabricated document");
});

test("the system prompt names the finalize tool for both the notes and no-data cases", () => {
  expect(PROCESS_GRANOLA_CALL_SYSTEM_PROMPT).toContain(
    PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
  );
  expect(PROCESS_GRANOLA_CALL_SYSTEM_PROMPT).toContain('status: "notes"');
  expect(PROCESS_GRANOLA_CALL_SYSTEM_PROMPT).toContain('status: "no-data"');
});

test("the no-data path still teaches the human what to check next, not a bare failure", () => {
  const lowered = PROCESS_GRANOLA_CALL_SYSTEM_PROMPT.toLowerCase();
  expect(lowered).toContain("granola connector");
  expect(lowered).toContain("next steps");
});

test("the definition binds @corbits/granola-tools' declared handle to a tenant-owned granola credential", () => {
  const definition = buildProcessGranolaCallWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual([
    ...PROCESS_GRANOLA_CALL_CREDENTIAL_BINDINGS,
  ]);
  expect(PROCESS_GRANOLA_CALL_CREDENTIAL_BINDINGS).toEqual([
    {
      package: "@corbits/granola-tools",
      handle: "granola",
      provider: "granola",
      locator: "tenant",
    },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildProcessGranolaCallWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeProcessGranolaCallWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: PROCESS_GRANOLA_CALL_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [PROCESS_GRANOLA_CALL_STEP_ID],
    steps: {
      [PROCESS_GRANOLA_CALL_STEP_ID]: {
        kind: "step",
        id: PROCESS_GRANOLA_CALL_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: PROCESS_GRANOLA_CALL_STEP_ID,
          systemPrompt: PROCESS_GRANOLA_CALL_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeProcessGranolaCallWorkflow(poisoned)).toThrow(
    /steps\.process-granola-call\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildProcessGranolaCallWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildProcessGranolaCallWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildProcessGranolaCallWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
