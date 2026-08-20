// Tests for this package's own contract: the shape our factory commits
// to, its serialization guarantees, and its boundary. The platform's own
// normalization and validation are its business, not re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  ATTIO_MCP_SERVER_SLUG,
  ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
  ATTIO_TASK_AGENT_STEP_ID,
  ATTIO_TASK_AGENT_SYSTEM_PROMPT,
  ATTIO_TASK_AGENT_TOOL_PACKAGE_PINS,
  ATTIO_TASK_AGENT_WORKFLOW_ID,
  buildAttioTaskAgentWorkflow,
  serializeAttioTaskAgentWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 900000,
} as const;

function workStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[ATTIO_TASK_AGENT_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${ATTIO_TASK_AGENT_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition folds the OG twenty-one-step pipeline into exactly one step", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([ATTIO_TASK_AGENT_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([ATTIO_TASK_AGENT_STEP_ID]);
});

test("the definition uses no action or awaitSignal primitive — this host can dispatch neither", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  const kinds = Object.values(definition.steps).map(
    (primitive) => primitive.kind,
  );
  expect(kinds).toEqual(["step"]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  expect(workStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  expect(definition.id).toBe(ATTIO_TASK_AGENT_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt and the caller's preferences, and inlines no tools", () => {
  const agent = workStep(buildAttioTaskAgentWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(ATTIO_TASK_AGENT_SYSTEM_PROMPT);
  expect(agent.inference).toEqual({ sources: INPUT.inferencePreferences });
  expect(agent.toolFactories).toEqual([]);
});

test("one MCP pin covers the CRM, past calls, and the web — the OG needed three tool packages", () => {
  const agent = workStep(buildAttioTaskAgentWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual(ATTIO_TASK_AGENT_TOOL_PACKAGE_PINS);
  expect(ATTIO_TASK_AGENT_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/mcp-tools", version: "0.0.5" },
  ]);
});

test("the definition declares no static credential binding — mcp:<slug> is dynamic tenant data the host supplies", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  expect(definition.credentialBindings ?? []).toEqual([]);
});

test("the prompt names the CRM server slug and the finalize tool the package actually exports", () => {
  expect(ATTIO_MCP_SERVER_SLUG).toBe("attio");
  expect(ATTIO_TASK_AGENT_SYSTEM_PROMPT).toContain(
    `"${ATTIO_MCP_SERVER_SLUG}" server`,
  );
  expect(ATTIO_TASK_AGENT_SYSTEM_PROMPT).toContain(
    ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
  );
});

test("the definition survives the workflow-asset JSON round trip unchanged", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  expect(JSON.parse(serializeAttioTaskAgentWorkflow(definition))).toEqual(
    JSON.parse(JSON.stringify(definition)),
  );
});

test("serializing a definition JSON would mangle fails loudly, naming the path", () => {
  const definition = buildAttioTaskAgentWorkflow(INPUT);
  const poisoned = {
    ...definition,
    steps: { ...definition.steps, poison: () => undefined },
  } as unknown as WorkflowDefinition;
  expect(() => serializeAttioTaskAgentWorkflow(poisoned)).toThrow(
    /definition\.steps\.poison is a function/,
  );
});

test("an empty trigger address is rejected at build time", () => {
  expect(() =>
    buildAttioTaskAgentWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/non-empty triggerAddress/);
});

test("a non-positive turn timeout is rejected at build time", () => {
  expect(() =>
    buildAttioTaskAgentWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/positive integer/);
});
