// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  MORNING_BRIEF_CREDENTIAL_BINDINGS,
  MORNING_BRIEF_FINALIZE_TOOL_NAME,
  MORNING_BRIEF_PENDING_SOURCES,
  MORNING_BRIEF_SECTIONS,
  MORNING_BRIEF_STEP_ID,
  MORNING_BRIEF_SYSTEM_PROMPT,
  MORNING_BRIEF_TOOL_PACKAGE_PINS,
  MORNING_BRIEF_WIRED_SOURCES,
  MORNING_BRIEF_WORKFLOW_ID,
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "morning-brief@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120000,
} as const;

function morningBriefStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[MORNING_BRIEF_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${MORNING_BRIEF_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([MORNING_BRIEF_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([MORNING_BRIEF_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(morningBriefStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(definition.id).toBe(MORNING_BRIEF_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = morningBriefStep(buildMorningBriefWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(MORNING_BRIEF_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the agent pins the wired sources' tool packages by name and version", () => {
  const agent = morningBriefStep(buildMorningBriefWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual([...MORNING_BRIEF_TOOL_PACKAGE_PINS]);
  expect(MORNING_BRIEF_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/granola-tools", version: "0.0.4" },
    { name: "@corbits/linear-tools", version: "0.0.4" },
  ]);
});

test("the prompt names the fixed section headings, in order", () => {
  expect(MORNING_BRIEF_SECTIONS).toEqual([
    "What happened",
    "What needs attention today",
    "Suggested next actions",
  ]);
  let lastIndex = -1;
  for (const heading of MORNING_BRIEF_SECTIONS) {
    const index = MORNING_BRIEF_SYSTEM_PROMPT.indexOf(heading);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
});

test("the prompt instructs honest degradation for every wired and pending source", () => {
  for (const source of MORNING_BRIEF_WIRED_SOURCES) {
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain(source);
  }
  for (const source of MORNING_BRIEF_PENDING_SOURCES) {
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain(source);
  }
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(/not connected/);
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(/never fabricate/i);
});

test("the prompt requires an honest failure state when nothing is connected", () => {
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(
    /no connected sources to report from today/,
  );
});

test("the prompt names the exact approval-gated finalize tool", () => {
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain(
    MORNING_BRIEF_FINALIZE_TOOL_NAME,
  );
});

test("the prompt commits to always finalizing, even with a teaching payload on the no-data path", () => {
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(/teaching/i);
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(
    /never end a run without finalizing/i,
  );
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain("granola");
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain("linear");
});

test("the prompt commits to a calm terminal reply on denial, not an error", () => {
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(/not approved/i);
  expect(MORNING_BRIEF_SYSTEM_PROMPT).toMatch(
    /never present a denial as an error/i,
  );
});

test("the definition binds @corbits/granola-tools' and @corbits/linear-tools' declared handles to their tenant-owned credentials", () => {
  const definition = buildMorningBriefWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual([
    ...MORNING_BRIEF_CREDENTIAL_BINDINGS,
  ]);
  expect(MORNING_BRIEF_CREDENTIAL_BINDINGS).toEqual([
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
  const definition = buildMorningBriefWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeMorningBriefWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: MORNING_BRIEF_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [MORNING_BRIEF_STEP_ID],
    steps: {
      "morning-brief": {
        kind: "step",
        id: MORNING_BRIEF_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: MORNING_BRIEF_STEP_ID,
          systemPrompt: MORNING_BRIEF_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeMorningBriefWorkflow(poisoned)).toThrow(
    /steps\.morning-brief\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildMorningBriefWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildMorningBriefWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildMorningBriefWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
