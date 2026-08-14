// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  REDDIT_OPPORTUNITY_SCANNER_STEP_ID,
  REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT,
  REDDIT_OPPORTUNITY_SCANNER_WORKFLOW_ID,
  buildRedditOpportunityScannerWorkflow,
  serializeRedditOpportunityScannerWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
} as const;

function scannerStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[REDDIT_OPPORTUNITY_SCANNER_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${REDDIT_OPPORTUNITY_SCANNER_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildRedditOpportunityScannerWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([REDDIT_OPPORTUNITY_SCANNER_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([
    REDDIT_OPPORTUNITY_SCANNER_STEP_ID,
  ]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildRedditOpportunityScannerWorkflow(INPUT);
  expect(scannerStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildRedditOpportunityScannerWorkflow(INPUT);
  expect(definition.id).toBe(REDDIT_OPPORTUNITY_SCANNER_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt, the preferences, and inlines no tools", () => {
  const agent = scannerStep(buildRedditOpportunityScannerWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the system prompt names the exact approval-gated finalize tool", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toContain(
    REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  );
});

test("the system prompt names the real Reddit and scrape tools by their exact names", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toContain(
    "firecrawl_scrape",
  );
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toContain("reddit_search");
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toContain(
    "reddit_subreddit_search",
  );
});

test("the system prompt commits to an honest no-scrape failure, not fabricated site content", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toMatch(
    /never fabricate what the site sells/i,
  );
});

test("the system prompt requires the search plan to be reviewed before any search runs", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toMatch(
    /never search reddit before this is approved/i,
  );
});

test("the system prompt collapses opportunity selection into one approval, not a second gate", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toMatch(
    /exactly once with the full set of opportunities the sender chose/i,
  );
});

test("the system prompt commits to a calm terminal reply on denial, not an error", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toMatch(/not approved/i);
  expect(REDDIT_OPPORTUNITY_SCANNER_SYSTEM_PROMPT).toMatch(
    /never present a denial as an error/i,
  );
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildRedditOpportunityScannerWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeRedditOpportunityScannerWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildRedditOpportunityScannerWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildRedditOpportunityScannerWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildRedditOpportunityScannerWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
