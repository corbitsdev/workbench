// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  PAIN_POINT_COLLATERAL_CREDENTIAL_BINDINGS,
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
  PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
  PAIN_POINT_COLLATERAL_STEP_ID,
  PAIN_POINT_COLLATERAL_SYSTEM_PROMPT,
  PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS,
  PAIN_POINT_COLLATERAL_WORKFLOW_ID,
  buildPainPointCollateralWorkflow,
  serializePainPointCollateralWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
} as const;

function collateralStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[PAIN_POINT_COLLATERAL_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${PAIN_POINT_COLLATERAL_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildPainPointCollateralWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([PAIN_POINT_COLLATERAL_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([
    PAIN_POINT_COLLATERAL_STEP_ID,
  ]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildPainPointCollateralWorkflow(INPUT);
  expect(collateralStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildPainPointCollateralWorkflow(INPUT);
  expect(definition.id).toBe(PAIN_POINT_COLLATERAL_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = collateralStep(buildPainPointCollateralWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the agent pins @corbits/granola-tools by name and version", () => {
  const agent = collateralStep(buildPainPointCollateralWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual([
    ...PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS,
  ]);
  expect(PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/granola-tools", version: "0.0.4" },
  ]);
});

test("the system prompt names the exact approval-gated finalize tool", () => {
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toContain(
    PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
  );
});

test("the system prompt names the intake tool and requires calling it first", () => {
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toContain(
    PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
  );
});

test("the system prompt names both trigger-carried fields unambiguously", () => {
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toContain("`transcript`");
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toContain("`noteId`");
});

test("the system prompt commits to a teaching artifact, not silence, when intake finds nothing", () => {
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toMatch(/no transcript/i);
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toMatch(/never invent/i);
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toMatch(
    /teaching payload instead of stopping silently/i,
  );
});

test("the system prompt commits to a calm terminal reply on denial, not an error", () => {
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toMatch(/not approved/i);
  expect(PAIN_POINT_COLLATERAL_SYSTEM_PROMPT).toMatch(
    /never present a denial as an error/i,
  );
});

test("the definition binds @corbits/granola-tools' declared handle to a tenant-owned granola credential", () => {
  const definition = buildPainPointCollateralWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual([
    ...PAIN_POINT_COLLATERAL_CREDENTIAL_BINDINGS,
  ]);
  expect(PAIN_POINT_COLLATERAL_CREDENTIAL_BINDINGS).toEqual([
    {
      package: "@corbits/granola-tools",
      handle: "granola",
      provider: "granola",
      locator: "tenant",
    },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildPainPointCollateralWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializePainPointCollateralWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildPainPointCollateralWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildPainPointCollateralWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildPainPointCollateralWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
