// Tests this package's own contract: the shape the factory commits to,
// that the reviewer lenses are not restated here, and that the
// definition survives the asset round-trip.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review";

import {
  buildCodeReviewWorkflow,
  CODE_REVIEW_STEP_ID,
  CODE_REVIEW_SYSTEM_PROMPT,
  CODE_REVIEW_TOOL_PACKAGE_PINS,
  CODE_REVIEW_WEBHOOK_INPUT_TEMPLATE,
  CODE_REVIEW_WORKFLOW_ID,
  serializeCodeReviewWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function reviewStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[CODE_REVIEW_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(`definition has no step named ${CODE_REVIEW_STEP_ID}`);
  }
  return primitive;
}

test("the definition is one mail-triggered step the webhook ingress can launch", () => {
  const definition = buildCodeReviewWorkflow(INPUT);
  expect(definition.id).toBe(CODE_REVIEW_WORKFLOW_ID);
  expect(definition.stepOrder).toEqual([CODE_REVIEW_STEP_ID]);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the step pins GitHub reach and sets an explicit turn timeout", () => {
  const primitive = reviewStep(buildCodeReviewWorkflow(INPUT));
  expect(primitive.timeout).toBe(INPUT.turnTimeoutMs);
  expect(primitive.agent.toolPackagePins).toEqual(
    CODE_REVIEW_TOOL_PACKAGE_PINS,
  );
  expect(primitive.agent.toolFactories).toEqual([]);
});

test("every reviewer lens reaches the prompt from the shared roster", () => {
  for (const reviewer of CODE_REVIEW_REVIEWERS) {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain(reviewer.displayName);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toContain(reviewer.systemPrompt);
  }
});

test("the prompt commits to reading the diff, posting once, and never merging", () => {
  expect(CODE_REVIEW_SYSTEM_PROMPT).toContain("github_pull_request_diff");
  expect(CODE_REVIEW_SYSTEM_PROMPT).toContain(
    "github_post_pull_request_review",
  );
  expect(CODE_REVIEW_SYSTEM_PROMPT).toContain(
    "never approve, request changes, or merge",
  );
});

test("the webhook input template names the pull request from the event", () => {
  expect(CODE_REVIEW_WEBHOOK_INPUT_TEMPLATE).toContain(
    "{{pull_request.html_url}}",
  );
});

test("the definition survives the workflow-asset round trip", () => {
  const definition = buildCodeReviewWorkflow(INPUT);
  const round = JSON.parse(
    serializeCodeReviewWorkflow(definition),
  ) as WorkflowDefinition;
  expect(round.stepOrder).toEqual(definition.stepOrder);
  expect(round.id).toBe(definition.id);
});

test("a blank trigger address or a bad timeout is refused at build time", () => {
  expect(() =>
    buildCodeReviewWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
  expect(() => buildCodeReviewWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
});
