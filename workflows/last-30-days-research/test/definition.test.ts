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
  LAST_30_DAYS_RESEARCH_STEP_IDS,
  LAST_30_DAYS_RESEARCH_WIRED_SOURCES,
  LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
  WRITER_INFERENCE_PREFERENCE,
  WRITER_MODEL_ID,
  WRITER_MODEL_PROVIDER,
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

test("the definition is a six-step pipeline with no intake gate", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(LAST_30_DAYS_RESEARCH_STEP_IDS).toEqual([
    "ground",
    "gather",
    "entities",
    "gather2",
    "curate",
    "write",
  ]);
  expect(definition.stepOrder).toEqual([...LAST_30_DAYS_RESEARCH_STEP_IDS]);
  expect(Object.keys(definition.steps).sort()).toEqual(
    [...LAST_30_DAYS_RESEARCH_STEP_IDS].sort(),
  );
  expect(definition.steps.intake).toBeUndefined();
});

test("ground is the first step and reads the triggering mail as topic/focus", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const ground = stepPrimitive(definition, "ground");
  expect(ground.after).toEqual([]);
  expect(ground.input).toEqual({ from: "trigger.payload" });
});

test("every reasoning step chains serially, ground through write", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const expectedPredecessor: Record<string, string> = {
    gather: "ground",
    entities: "gather",
    gather2: "entities",
    curate: "gather2",
    write: "curate",
  };
  for (const [id, predecessor] of Object.entries(expectedPredecessor)) {
    expect(stepPrimitive(definition, id).after).toEqual([predecessor]);
  }
});

test("every reasoning step carries an explicit per-turn timeout and inlines no tools", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  for (const id of [
    "ground",
    "gather",
    "entities",
    "gather2",
    "curate",
    "write",
  ]) {
    const primitive = stepPrimitive(definition, id);
    expect(primitive.timeout).toBe(INPUT.turnTimeoutMs);
    expect(primitive.agent.toolFactories).toEqual([]);
    expect(primitive.agent.capabilities).toEqual([]);
  }
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.id).toBe(LAST_30_DAYS_RESEARCH_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("grounding, gathering, and entity-extraction ride the deploy default — no writer preference", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  for (const id of ["ground", "gather", "entities", "gather2"]) {
    expect(stepPrimitive(definition, id).agent.inference.sources).toEqual([
      ...INPUT.inferencePreferences,
    ]);
  }
});

test("curate and write prepend the writer-tier preference ahead of the deploy default", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(WRITER_INFERENCE_PREFERENCE).toEqual({
    provider: WRITER_MODEL_PROVIDER,
    model: WRITER_MODEL_ID,
  });
  expect(WRITER_MODEL_PROVIDER).toBe("anthropic");
  expect(WRITER_MODEL_ID).toBe("claude-sonnet-5");
  for (const id of ["curate", "write"]) {
    expect(stepPrimitive(definition, id).agent.inference.sources).toEqual([
      WRITER_INFERENCE_PREFERENCE,
      ...INPUT.inferencePreferences,
    ]);
  }
});

test("each step's input selector chains off the prior step's output, plus the triggering mail where the prompt needs the topic/focus", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(stepPrimitive(definition, "ground").input).toEqual({
    from: "trigger.payload",
  });
  expect(stepPrimitive(definition, "gather").input).toEqual({
    merge: [{ from: "trigger.payload" }, { from: "steps.ground.output" }],
  });
  expect(stepPrimitive(definition, "entities").input).toEqual({
    merge: [{ from: "trigger.payload" }, { from: "steps.gather.output" }],
  });
  expect(stepPrimitive(definition, "gather2").input).toEqual({
    merge: [{ from: "trigger.payload" }, { from: "steps.entities.output" }],
  });
  expect(stepPrimitive(definition, "curate").input).toEqual({
    merge: [
      { from: "trigger.payload" },
      { from: "steps.gather.output" },
      { from: "steps.gather2.output" },
    ],
  });
  expect(stepPrimitive(definition, "write").input).toEqual({
    merge: [{ from: "trigger.payload" }, { from: "steps.curate.output" }],
  });
});

test("the grounding prompt tailors a query per wired source, never the raw topic verbatim", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, "ground").agent.systemPrompt;
  expect(prompt).toContain('"web"');
  expect(prompt).toContain('"github"');
});

test("the gathering prompt names the two wired tools and every pending source, honestly", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, "gather").agent.systemPrompt;
  expect(LAST_30_DAYS_RESEARCH_WIRED_SOURCES).toEqual(["Web search", "GitHub"]);
  expect(prompt).toContain("web_search");
  expect(prompt).toContain("github_activity");
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
  expect(prompt).toMatch(/never fabricate/i);
  expect(stepPrimitive(definition, "gather2").agent.systemPrompt).toBe(prompt);
});

test("the write step's prompt names the fixed report section headings, in order", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, "write").agent.systemPrompt;
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

test("the write step names the exact approval-gated finalize tool and commits to always finalizing", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, "write").agent.systemPrompt;
  expect(prompt).toContain(LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME);
  expect(prompt).toMatch(/never end a run without finalizing/i);
  expect(prompt).toContain("exa");
});

test("the write step commits to a calm terminal reply on denial, not an error", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  const prompt = stepPrimitive(definition, "write").agent.systemPrompt;
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
