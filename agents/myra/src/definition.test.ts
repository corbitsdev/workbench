// The two facts about Myra's entry that a deploy silently depends on: she
// carries real tool factories (the source lineage resolves no pins, so an
// empty list means an agent with no tools), and she stays single-step.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID, buildMyraWorkflow, myraDirector } from "./index";
import { mcpToolNamePattern } from "./workflow-ids";

const INPUT = {
  workflowId: ASSISTANT_WORKFLOW_ID,
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  systemPrompt: "You are Myra.",
  hubCredentialId: "crd_000000000000000000000000000000ab",
  mcpServers: [],
} as const;

function assistantStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[ASSISTANT_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(`definition has no step primitive named ${ASSISTANT_STEP_ID}`);
  }
  return primitive;
}

test("the agent carries its tool factories inline, not as pins", () => {
  const agent = assistantStep(buildMyraWorkflow(INPUT)).agent;
  expect(agent.toolFactories.length).toBeGreaterThan(0);
  // Every factory must be callable and namespaced: the sidecar reads
  // `factory.id` as the tool package name for the source lineage.
  for (const factory of agent.toolFactories) {
    expect(typeof factory).toBe("function");
    expect(factory.id).toMatch(/^@?[^/]+\/.+/);
  }
  expect(agent.toolPackagePins).toEqual([]);
});

test("the definition has exactly one step, so a deployment stays conversational", () => {
  // A single-step deployment keeps one warm agent with durable memory
  // across runs; a second step would silently trade that memory away.
  const definition = buildMyraWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([ASSISTANT_STEP_ID]);
  expect(assistantStep(definition).triggers).toBe("unbounded");
});

test("the step carries no timeout, so an approval park never aborts the run", () => {
  // A step timeout stays armed across an approval park, so any finite
  // value aborts a warm agent waiting on a person to answer an ask gate.
  expect(assistantStep(buildMyraWorkflow(INPUT)).timeout).toBeUndefined();
});

test("turn one carries only core tools: each bound server adds one deferred namespace", () => {
  // A chat binds the whole workspace catalog, so the visible set must not
  // grow with it — every server's namespace stays behind tool_search.
  const bare = myraDirector([]);
  const bound = myraDirector(["exa", "linear"]);
  expect(bound.id).toBe("@corbits/deferred-tools/director");
  expect(bound.config.visible).toEqual(bare.config.visible);
  expect(bound.config.visible.length).toBeGreaterThan(0);
  for (const name of bound.config.visible) {
    expect(name.endsWith(".*")).toBe(false);
    expect(name.includes(".")).toBe(false);
  }
  const added = bound.config.deferred.filter((name) => !bare.config.deferred.includes(name));
  expect(added).toEqual([mcpToolNamePattern("exa"), mcpToolNamePattern("linear")]);
});

function mcpDeployment(handle: string) {
  return {
    handle,
    url: `https://${handle}.example/mcp`,
    credentialId: "crd_00000000000000000000000000000ab",
    providerName: `mcp-${handle}`,
    credentialName: `mcp-${handle}`,
    tools: [],
  };
}

test("the definition binds every catalog server, each with its own credential", () => {
  const definition = buildMyraWorkflow({
    ...INPUT,
    mcpServers: [mcpDeployment("exa"), mcpDeployment("linear")],
  });
  // Two hub bindings plus one per server; same for the use requirements.
  expect(definition.credentialBindings.length).toBe(4);
  expect(definition.grantRequirements.length).toBe(4);
  const director = assistantStep(definition).agent.director as {
    config: { deferred: readonly string[] };
  };
  expect(director.config.deferred).toEqual(
    expect.arrayContaining([mcpToolNamePattern("exa"), mcpToolNamePattern("linear")]),
  );
});
