// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
  LAST_30_DAYS_RESEARCH_PENDING_SOURCES,
  LAST_30_DAYS_RESEARCH_SECTIONS,
  LAST_30_DAYS_RESEARCH_STEP_ID,
  LAST_30_DAYS_RESEARCH_TOOL_PACKAGE_PINS,
  LAST_30_DAYS_RESEARCH_WIRED_SOURCES,
  LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "last-30-days-research@example.test",
  inferencePreferences: [{ provider: "ollama", model: "qwen-test" }],
  turnTimeoutMs: 300000,
} as const;

function stepPrimitive(
  definition: WorkflowDefinition,
  id: string,
): StepPrimitive {
  const primitive = definition.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(`expected step primitive for "${id}"`);
  }
  return primitive;
}

test("the definition is a single-step pipeline — the only shape this repo's routine launcher can run", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([LAST_30_DAYS_RESEARCH_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([
    LAST_30_DAYS_RESEARCH_STEP_ID,
  ]);
});

test("the one step is mail-triggered and reads the triggering mail as topic/focus via trigger.payload", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the step carries an explicit per-turn timeout, no inline tools, and the two wired tool-package pins", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const only = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID);
  expect(only.timeout).toBe(INPUT.turnTimeoutMs);
  expect(only.agent.toolFactories).toEqual([]);
  expect(only.agent.capabilities).toEqual([]);
  expect(LAST_30_DAYS_RESEARCH_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/web-search-tools", version: "0.0.3" },
    { name: "@corbits/github-tools", version: "0.0.5" },
  ]);
  expect(only.agent.toolPackagePins).toEqual(
    LAST_30_DAYS_RESEARCH_TOOL_PACKAGE_PINS,
  );
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.id).toBe(LAST_30_DAYS_RESEARCH_WORKFLOW_ID);
});

test("the step's turn rides the caller's own inference preferences, unmodified", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const only = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID);
  expect(only.agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
});

test("the system prompt walks all six research phases and names every pending source, honestly", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID).agent
    .systemPrompt;
  expect(LAST_30_DAYS_RESEARCH_WIRED_SOURCES).toEqual(["Web search", "GitHub"]);
  expect(prompt).toContain("web_search");
  expect(prompt).toContain("github_activity");
  expect(prompt).toMatch(/phase 1/i);
  expect(prompt).toMatch(/phase 6/i);
  expect(LAST_30_DAYS_RESEARCH_PENDING_SOURCES).toEqual([
    "Hacker News",
    "Reddit",
    "X",
    "YouTube",
    "Polymarket",
  ]);
  for (const source of LAST_30_DAYS_RESEARCH_PENDING_SOURCES) {
    expect(prompt).toContain(source);
  }
  expect(prompt).toMatch(/not (yet )?connected/i);
  expect(prompt).not.toMatch(/bluesky/i);
});

test("the prompt names the fixed report section headings, in order", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID).agent
    .systemPrompt;
  expect(LAST_30_DAYS_RESEARCH_SECTIONS).toEqual([
    "Overview",
    "Key findings",
    "Sources consulted",
    "Citations",
  ]);
  let lastIndex = -1;
  for (const heading of LAST_30_DAYS_RESEARCH_SECTIONS) {
    const index = prompt.indexOf(heading);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
});

test("the prompt names the exact approval-gated finalize tool and commits to always finalizing", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID).agent
    .systemPrompt;
  expect(prompt).toContain(LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME);
  expect(prompt).toMatch(/never end a run without finalizing/i);
  expect(prompt).toContain("exa");
});

test("the prompt commits to a calm terminal reply on denial, not an error", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, LAST_30_DAYS_RESEARCH_STEP_ID).agent
    .systemPrompt;
  expect(prompt).toMatch(/not approved/i);
  expect(prompt).toMatch(/never present a denial as an error/i);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeLast30DaysResearchWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: ["write"],
    steps: {
      write: {
        kind: "step",
        id: "write",
        drainBehavior: "cancel",
        agent: {
          id: "write",
          systemPrompt: "x",
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeLast30DaysResearchWorkflow(poisoned)).toThrow(
    /steps\.write\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildLast30DaysResearchWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildLast30DaysResearchWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildLast30DaysResearchWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
