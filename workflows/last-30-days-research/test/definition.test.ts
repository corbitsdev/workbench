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
  LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT,
  LAST_30_DAYS_RESEARCH_WIRED_SOURCES,
  LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "last-30-days-research@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
} as const;

function researchStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[LAST_30_DAYS_RESEARCH_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${LAST_30_DAYS_RESEARCH_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([LAST_30_DAYS_RESEARCH_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([
    LAST_30_DAYS_RESEARCH_STEP_ID,
  ]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(researchStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildLast30DaysResearchWorkflow(INPUT);
  expect(definition.id).toBe(LAST_30_DAYS_RESEARCH_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = researchStep(buildLast30DaysResearchWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the prompt names the fixed report section headings, in order", () => {
  expect(LAST_30_DAYS_RESEARCH_SECTIONS).toEqual([
    "Overview",
    "Key findings",
    "Sources consulted",
    "Citations",
  ]);
  let lastIndex = -1;
  for (const heading of LAST_30_DAYS_RESEARCH_SECTIONS) {
    const index = LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT.indexOf(heading);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
});

test("the prompt names the two wired sources' real tools", () => {
  expect(LAST_30_DAYS_RESEARCH_WIRED_SOURCES).toEqual(["Web search", "GitHub"]);
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toContain("web_search");
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toContain("github_activity");
});

test("the prompt is honest about every pending source, scoped down per the survey's recommendation", () => {
  expect(LAST_30_DAYS_RESEARCH_PENDING_SOURCES).toEqual([
    "Hacker News",
    "Reddit",
    "X",
    "YouTube",
    "Polymarket",
  ]);
  for (const source of LAST_30_DAYS_RESEARCH_PENDING_SOURCES) {
    expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toContain(source);
  }
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(/not (yet )?connected/i);
  // Bluesky is disabled upstream in the OG source (broken auth) — this
  // port skips it entirely, not even as a named pending source.
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).not.toMatch(/bluesky/i);
});

test("the prompt commits to never fabricating a source or its results", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(/never fabricate/i);
});

test("the prompt requires the Sources consulted section to name every source it actually reached, not hide a failure", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(
    /sources consulted.{0,400}(which sources|actually (reached|consulted))/is,
  );
});

test("the prompt requires an honest failure state when nothing is connected", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(
    /no source (results|material) to report/i,
  );
});

test("the prompt requires an honest 'no topic' failure state rather than inventing one", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(/no topic/i);
});

test("the prompt names the exact approval-gated finalize tool", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toContain(
    LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
  );
});

test("the prompt commits to always finalizing, even with a teaching payload on the no-data path", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(/teaching/i);
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(
    /never end a run without finalizing/i,
  );
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toContain("exa");
});

test("the prompt commits to a calm terminal reply on denial, not an error", () => {
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(/not approved/i);
  expect(LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT).toMatch(
    /never present a denial as an error/i,
  );
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
    stepOrder: [LAST_30_DAYS_RESEARCH_STEP_ID],
    steps: {
      [LAST_30_DAYS_RESEARCH_STEP_ID]: {
        kind: "step",
        id: LAST_30_DAYS_RESEARCH_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: LAST_30_DAYS_RESEARCH_STEP_ID,
          systemPrompt: LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeLast30DaysResearchWorkflow(poisoned)).toThrow(
    new RegExp(
      `steps\\.${LAST_30_DAYS_RESEARCH_STEP_ID}\\.agent\\.toolFactories\\[0\\]`,
    ),
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
