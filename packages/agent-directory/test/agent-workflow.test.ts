// Tests for this package's own contract: the definition shape a
// hand-authored agent commits to, its serialization guarantees, and
// its boundary errors. The platform's own hydration/deploy validation
// is its business, not re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  AGENT_DEFINITION_STEP_ID,
  AGENT_SKILLS_ASSET_PATH,
  buildAgentDefinitionWorkflow,
  parseAgentSkills,
  serializeAgentDefinitionWorkflow,
  serializeAgentSkills,
} from "../src/agent-workflow";

const INPUT = {
  handle: "research-buddy",
  tenantDomain: "example.test",
  description: "Answers research questions",
  systemPrompt: "You are a careful research assistant.",
} as const;

function agentStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[AGENT_DEFINITION_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${AGENT_DEFINITION_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step, so a launch stays conversational", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([AGENT_DEFINITION_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([AGENT_DEFINITION_STEP_ID]);
});

test("the system prompt and description land on the step's agent", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  const step = agentStep(definition);
  expect(step.agent.systemPrompt).toBe(INPUT.systemPrompt);
  expect(step.agent.description).toBe(INPUT.description);
});

test("an omitted model leaves the agent with no inference sources", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  const step = agentStep(definition);
  expect(step.agent.inference.sources).toEqual([]);
});

test("a supplied model becomes the agent's one inference source", () => {
  const definition = buildAgentDefinitionWorkflow({
    ...INPUT,
    model: "claude-sonnet-test",
  });
  const step = agentStep(definition);
  expect(step.agent.inference.sources).toEqual([
    { provider: "catalog", model: "claude-sonnet-test" },
  ]);
});

test("an omitted toolPackagePins leaves the agent with no pins, exactly like a definition built before this field existed", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  const step = agentStep(definition);
  expect(step.agent.toolPackagePins).toBeUndefined();
});

test("a supplied toolPackagePins lands on the step's agent verbatim", () => {
  const pins = [{ name: "@corbits/granola-tools", version: "^1.0.0" }];
  const definition = buildAgentDefinitionWorkflow({
    ...INPUT,
    toolPackagePins: pins,
  });
  const step = agentStep(definition);
  expect(step.agent.toolPackagePins).toEqual(pins);
});

test("the trigger address is derived from the handle and tenant domain", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  expect(definition.triggers).toEqual([
    { type: "mail", to: "research-buddy@example.test" },
  ]);
});

test("an empty handle is rejected", () => {
  expect(() => buildAgentDefinitionWorkflow({ ...INPUT, handle: "" })).toThrow(
    /non-empty handle/,
  );
});

test("an empty system prompt is rejected", () => {
  expect(() =>
    buildAgentDefinitionWorkflow({ ...INPUT, systemPrompt: "" }),
  ).toThrow(/non-empty systemPrompt/);
});

test("serialization round-trips through JSON byte-faithfully", () => {
  const definition = buildAgentDefinitionWorkflow(INPUT);
  const json = serializeAgentDefinitionWorkflow(definition);
  expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(definition)));
});

test("skills asset path is a sibling of workflow.json, not a subdirectory", () => {
  expect(AGENT_SKILLS_ASSET_PATH).toBe("skills.json");
});

test("a skills list round-trips through serialize/parse byte-faithfully", () => {
  const skills = ["web-research", "long-form-write"];
  const bytes = new TextEncoder().encode(serializeAgentSkills(skills));
  expect(parseAgentSkills(bytes)).toEqual(skills);
});

test("an empty skills list serializes and parses back empty", () => {
  const bytes = new TextEncoder().encode(serializeAgentSkills([]));
  expect(parseAgentSkills(bytes)).toEqual([]);
});

test("malformed skills.json content fails closed rather than silently dropping skills", () => {
  const bytes = new TextEncoder().encode("not json");
  expect(() => parseAgentSkills(bytes)).toThrow();
});

test("skills.json missing the skills key fails closed", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ notSkills: [] }));
  expect(() => parseAgentSkills(bytes)).toThrow();
});
