// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  COLLATERAL_CONTENT_TYPES,
  COLLATERAL_GENERATION_CREDENTIAL_BINDINGS,
  COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  COLLATERAL_GENERATION_PENDING_SOURCES,
  COLLATERAL_GENERATION_STEP_ID,
  COLLATERAL_GENERATION_SYSTEM_PROMPT,
  COLLATERAL_GENERATION_TOOL_PACKAGE_PINS,
  COLLATERAL_GENERATION_WIRED_SOURCES,
  COLLATERAL_GENERATION_WORKFLOW_ID,
  buildCollateralGenerationWorkflow,
  serializeCollateralGenerationWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
} as const;

function collateralStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[COLLATERAL_GENERATION_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${COLLATERAL_GENERATION_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildCollateralGenerationWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([COLLATERAL_GENERATION_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([
    COLLATERAL_GENERATION_STEP_ID,
  ]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildCollateralGenerationWorkflow(INPUT);
  expect(collateralStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildCollateralGenerationWorkflow(INPUT);
  expect(definition.id).toBe(COLLATERAL_GENERATION_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = collateralStep(buildCollateralGenerationWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(COLLATERAL_GENERATION_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the agent pins @corbits/granola-tools and @corbits/linear-tools by name and version", () => {
  const agent = collateralStep(buildCollateralGenerationWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual([
    ...COLLATERAL_GENERATION_TOOL_PACKAGE_PINS,
  ]);
  expect(COLLATERAL_GENERATION_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/granola-tools", version: "0.0.1" },
    { name: "@corbits/linear-tools", version: "0.0.1" },
  ]);
});

test("the system prompt names the exact approval-gated finalize tool", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toContain(
    COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  );
});

test("the system prompt offers every content type by its exact id", () => {
  for (const type of COLLATERAL_CONTENT_TYPES) {
    expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toContain(type.id);
  }
  expect(COLLATERAL_CONTENT_TYPES).toHaveLength(7);
});

test("the system prompt names the wired sources' real tools, and is honest about the pending one", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toContain("granola_get_note");
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toContain(
    "linear_list_recent_issues",
  );
  expect(COLLATERAL_GENERATION_WIRED_SOURCES).toEqual([
    "Granola call notes",
    "Linear issues",
  ]);
  expect(COLLATERAL_GENERATION_PENDING_SOURCES).toEqual([
    "workbench artifacts",
  ]);
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(
    /workbench artifacts are not yet a reachable source/i,
  );
});

test("the system prompt commits to an honest 'nothing to draft from' failure, not fabricated source material", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(/nothing to draft from/i);
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(/never invent/i);
});

test("the system prompt commits to a teaching artifact, not silence, when nothing is reachable", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toContain(
    COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  );
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(/status-note/i);
});

test("the system prompt caps a rejected piece at one revise pass", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(
    /never revise the same piece a second time/i,
  );
});

test("the system prompt collapses review into one approval, not a second gate", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(
    /exactly once with the full set of approved pieces/i,
  );
});

test("the system prompt commits to a calm terminal reply on denial, not an error", () => {
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(/not approved/i);
  expect(COLLATERAL_GENERATION_SYSTEM_PROMPT).toMatch(
    /never present a denial as an error/i,
  );
});

test("the definition binds @corbits/granola-tools' and @corbits/linear-tools' declared handles to their tenant-owned credentials", () => {
  const definition = buildCollateralGenerationWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual([
    ...COLLATERAL_GENERATION_CREDENTIAL_BINDINGS,
  ]);
  expect(COLLATERAL_GENERATION_CREDENTIAL_BINDINGS).toEqual([
    {
      package: "@corbits/granola-tools",
      handle: "granola",
      provider: "granola",
      locator: "tenant",
    },
    {
      package: "@corbits/linear-tools",
      handle: "linear",
      provider: "linear",
      locator: "tenant",
    },
  ]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildCollateralGenerationWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeCollateralGenerationWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildCollateralGenerationWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildCollateralGenerationWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildCollateralGenerationWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
