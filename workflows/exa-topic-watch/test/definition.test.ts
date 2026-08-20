// Tests for this package's own contract: the shape our factory commits
// to, its serialization guarantees, and its boundary. The platform's own
// normalization and validation are its business, not re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  EXA_MCP_SERVER_SLUG,
  EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
  EXA_TOPIC_WATCH_SECTIONS,
  EXA_TOPIC_WATCH_STEP_ID,
  EXA_TOPIC_WATCH_SYSTEM_PROMPT,
  EXA_TOPIC_WATCH_TOOL_PACKAGE_PINS,
  EXA_TOPIC_WATCH_WORKFLOW_ID,
  buildExaTopicWatchWorkflow,
  serializeExaTopicWatchWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function digestStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[EXA_TOPIC_WATCH_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${EXA_TOPIC_WATCH_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition folds the OG six-step pipeline into exactly one step", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([EXA_TOPIC_WATCH_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([EXA_TOPIC_WATCH_STEP_ID]);
});

test("the definition uses no action primitive, which this host cannot dispatch", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  const kinds = Object.values(definition.steps).map(
    (primitive) => primitive.kind,
  );
  expect(kinds).toEqual(["step"]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  expect(digestStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  expect(definition.id).toBe(EXA_TOPIC_WATCH_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the fixed prompt and the caller's preferences, and inlines no tools", () => {
  const agent = digestStep(buildExaTopicWatchWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(EXA_TOPIC_WATCH_SYSTEM_PROMPT);
  expect(agent.inference).toEqual({ sources: INPUT.inferencePreferences });
  expect(agent.toolFactories).toEqual([]);
});

test("the step pins the MCP tools bundle, the one package a deploy here can resolve", () => {
  const agent = digestStep(buildExaTopicWatchWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual(EXA_TOPIC_WATCH_TOOL_PACKAGE_PINS);
  expect(EXA_TOPIC_WATCH_TOOL_PACKAGE_PINS).toEqual([
    { name: "@corbits/mcp-tools", version: "0.0.5" },
  ]);
});

test("the definition declares no static credential binding — mcp:<slug> is dynamic tenant data the host supplies", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  expect(definition.credentialBindings ?? []).toEqual([]);
});

test("the prompt names the Exa MCP server slug the agent has to pass as `server`", () => {
  expect(EXA_MCP_SERVER_SLUG).toBe("exa");
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain(`"${EXA_MCP_SERVER_SLUG}"`);
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain("mcp_read");
});

test("the prompt reaches the web read-only — never mcp_call, which would gate every search on an approval", () => {
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).not.toContain("mcp_call");
});

test("the prompt names every digest section and both finalize outcomes", () => {
  for (const section of EXA_TOPIC_WATCH_SECTIONS) {
    expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain(section);
  }
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain(
    EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
  );
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain('outcome "digest"');
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain('outcome "status-note"');
});

test("a quiet run still finalizes rather than ending silently", () => {
  expect(EXA_TOPIC_WATCH_SYSTEM_PROMPT).toContain(
    "Never end a run without finalizing",
  );
});

test("the definition survives the workflow-asset JSON round trip unchanged", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  expect(JSON.parse(serializeExaTopicWatchWorkflow(definition))).toEqual(
    JSON.parse(JSON.stringify(definition)),
  );
});

test("serializing a definition JSON would mangle fails loudly, naming the path", () => {
  const definition = buildExaTopicWatchWorkflow(INPUT);
  const poisoned = {
    ...definition,
    steps: { ...definition.steps, poison: () => undefined },
  } as unknown as WorkflowDefinition;
  expect(() => serializeExaTopicWatchWorkflow(poisoned)).toThrow(
    /definition\.steps\.poison is a function/,
  );
});

test("an empty trigger address is rejected at build time", () => {
  expect(() =>
    buildExaTopicWatchWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/non-empty triggerAddress/);
});

test("a non-positive turn timeout is rejected at build time", () => {
  expect(() =>
    buildExaTopicWatchWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/positive integer/);
});
