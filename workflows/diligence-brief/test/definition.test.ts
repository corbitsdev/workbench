// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  DILIGENCE_BRIEF_CREDENTIAL_BINDINGS,
  DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
  DILIGENCE_BRIEF_SECTIONS,
  DILIGENCE_BRIEF_STEP_ID,
  DILIGENCE_BRIEF_TOOL_PACKAGE_PINS,
  DILIGENCE_BRIEF_WIRED_SOURCES,
  DILIGENCE_BRIEF_WORKFLOW_ID,
  buildDiligenceBriefWorkflow,
  serializeDiligenceBriefWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "diligence-brief@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function briefStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[DILIGENCE_BRIEF_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step named ${DILIGENCE_BRIEF_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition is one mail-triggered step", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  expect(definition.id).toBe(DILIGENCE_BRIEF_WORKFLOW_ID);
  expect(definition.stepOrder).toEqual([DILIGENCE_BRIEF_STEP_ID]);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the step pins web-search and memory tool packages and sets an explicit turn timeout", () => {
  const primitive = briefStep(buildDiligenceBriefWorkflow(INPUT));
  expect(primitive.timeout).toBe(INPUT.turnTimeoutMs);
  expect(primitive.agent.toolPackagePins).toEqual(
    DILIGENCE_BRIEF_TOOL_PACKAGE_PINS,
  );
  expect(DILIGENCE_BRIEF_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/web-search-tools", version: "0.0.3" },
    { name: "@corbits/memory-tools", version: "0.0.4" },
  ]);
  expect(primitive.agent.toolFactories).toEqual([]);
});

test("the definition binds the web-search package's exa handle to the tenant's connection", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  expect(definition.credentialBindings).toEqual(
    DILIGENCE_BRIEF_CREDENTIAL_BINDINGS,
  );
  expect(DILIGENCE_BRIEF_CREDENTIAL_BINDINGS).toEqual([
    {
      package: "@corbits/web-search-tools",
      handle: "exa",
      provider: "exa",
      locator: "tenant",
    },
  ]);
});

test("the prompt names the fixed five-section outline, in order", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  const prompt = briefStep(definition).agent.systemPrompt;
  expect(DILIGENCE_BRIEF_SECTIONS).toEqual([
    "Overview",
    "Team & Founders",
    "Product & Market",
    "Traction & Funding",
    "Risks & Open Questions",
  ]);
  let lastIndex = -1;
  for (const heading of DILIGENCE_BRIEF_SECTIONS) {
    const index = prompt.indexOf(heading);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
});

test("the prompt commits to checking memory before the web, and to the two wired sources", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  const prompt = briefStep(definition).agent.systemPrompt;
  expect(DILIGENCE_BRIEF_WIRED_SOURCES).toEqual(["Web search", "Firm memory"]);
  expect(prompt).toContain("memory_search");
  expect(prompt).toContain("web_search");
  expect(prompt.indexOf("memory_search")).toBeLessThan(
    prompt.indexOf("web_search"),
  );
  expect(prompt).toMatch(/never invent results/i);
  expect(prompt).toMatch(/never fabricate/i);
});

test("the prompt names the exact approval-gated finalize tool and commits to always finalizing", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  const prompt = briefStep(definition).agent.systemPrompt;
  expect(prompt).toContain(DILIGENCE_BRIEF_FINALIZE_TOOL_NAME);
  expect(prompt).toMatch(/never end a run without finalizing/i);
  expect(prompt).toContain("exa");
});

test("the prompt commits to a calm terminal reply on denial, not an error", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  const prompt = briefStep(definition).agent.systemPrompt;
  expect(prompt).toMatch(/not approved/i);
  expect(prompt).toMatch(/never present a denial as an error/i);
});

test("the definition survives the workflow-asset round trip", () => {
  const definition = buildDiligenceBriefWorkflow(INPUT);
  const round = JSON.parse(
    serializeDiligenceBriefWorkflow(definition),
  ) as WorkflowDefinition;
  expect(round).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: DILIGENCE_BRIEF_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [DILIGENCE_BRIEF_STEP_ID],
    steps: {
      [DILIGENCE_BRIEF_STEP_ID]: {
        kind: "step",
        id: DILIGENCE_BRIEF_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: DILIGENCE_BRIEF_STEP_ID,
          systemPrompt: "x",
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeDiligenceBriefWorkflow(poisoned)).toThrow(
    new RegExp(`steps\\.${DILIGENCE_BRIEF_STEP_ID}\\.agent\\.toolFactories\\[0\\]`),
  );
});

test("a blank trigger address or a bad timeout is refused at build time", () => {
  expect(() =>
    buildDiligenceBriefWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
  expect(() =>
    buildDiligenceBriefWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
});
