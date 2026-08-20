import { describe, expect, test } from "bun:test";
import { projectLiveToInert } from "@intx/workflow";

import type { AgentRuntimeConfig } from "./config";
import {
  AGENT_RUNTIME_SECTION_ID,
  AGENT_RUNTIME_STEP_ID,
  AGENT_RUNTIME_TURN_STEP_ID,
  agentRuntimeTurnRunId,
  buildAgentRuntimeWorkflow,
} from "./definition";

const baseConfig: AgentRuntimeConfig = {
  workflowId: "wf_run_a",
  agentId: "run_a",
  triggerAddress: "run_a@bench.example",
  systemPrompt: "You are helpful.",
  inferencePreferences: [
    { provider: "acme", model: "acme-1" },
    { provider: "acme", model: "acme-2" },
  ],
  toolPackagePins: [],
  credentialBindings: [],
  mode: { kind: "step" },
};

describe("buildAgentRuntimeWorkflow — step mode", () => {
  test("builds one unbounded agent step on the config's own address", () => {
    const definition = buildAgentRuntimeWorkflow(baseConfig);

    expect(definition.id).toBe("wf_run_a");
    expect(definition.stepOrder).toEqual([AGENT_RUNTIME_STEP_ID]);
    const stepPrimitive = definition.steps[AGENT_RUNTIME_STEP_ID];
    expect(stepPrimitive?.kind).toBe("step");
    expect(definition.triggers).toEqual([
      { type: "mail", to: "run_a@bench.example" },
    ]);
  });

  test("the step's trigger budget is unbounded, so a run never goes silent after one reply", () => {
    const definition = buildAgentRuntimeWorkflow(baseConfig);
    const stepPrimitive = definition.steps[AGENT_RUNTIME_STEP_ID];

    expect(stepPrimitive).toMatchObject({ triggers: "unbounded" });
  });

  test("carries the config's system prompt and inference chain onto the step agent", () => {
    const definition = buildAgentRuntimeWorkflow(baseConfig);

    expect(definition.steps[AGENT_RUNTIME_STEP_ID]).toMatchObject({
      agent: {
        id: "run_a",
        systemPrompt: "You are helpful.",
        inference: { sources: baseConfig.inferencePreferences },
      },
    });
  });

  test("carries the config's tool package pins onto the step agent", () => {
    const definition = buildAgentRuntimeWorkflow({
      ...baseConfig,
      toolPackagePins: [{ name: "@corbits/mcp-tools", version: "0.0.1" }],
    });

    expect(definition.steps[AGENT_RUNTIME_STEP_ID]).toMatchObject({
      agent: {
        toolPackagePins: [{ name: "@corbits/mcp-tools", version: "0.0.1" }],
      },
    });
  });

  test("declares the config's credential bindings on the definition itself", () => {
    const credentialBindings = [
      {
        package: "@corbits/mcp-tools",
        handle: "mcp:notion",
        provider: "notion",
        locator: "tenant" as const,
      },
    ];
    const definition = buildAgentRuntimeWorkflow({
      ...baseConfig,
      credentialBindings,
    });

    expect(definition.credentialBindings).toEqual(credentialBindings);
  });

  test("omits credentialBindings entirely when the config declares none", () => {
    expect(
      buildAgentRuntimeWorkflow(baseConfig).credentialBindings,
    ).toBeUndefined();
  });

  test("pins the step's input to a literal when the config supplies one", () => {
    const definition = buildAgentRuntimeWorkflow({
      ...baseConfig,
      mode: { kind: "step", literalInput: "wake up" },
    });

    expect(definition.steps[AGENT_RUNTIME_STEP_ID]).toMatchObject({
      input: { literal: "wake up" },
    });
  });

  test("leaves the step reading its real trigger payload by default", () => {
    const stepPrimitive =
      buildAgentRuntimeWorkflow(baseConfig).steps[AGENT_RUNTIME_STEP_ID];

    expect(stepPrimitive).not.toMatchObject({ input: { literal: undefined } });
  });
});

describe("buildAgentRuntimeWorkflow — section mode", () => {
  const sectionConfig: AgentRuntimeConfig = {
    ...baseConfig,
    mode: { kind: "section", turnTimeoutMs: 45_000 },
  };

  test("builds an onTrigger section on the config's address, not a plain step", () => {
    const definition = buildAgentRuntimeWorkflow(sectionConfig);

    expect(definition.stepOrder).toEqual([AGENT_RUNTIME_SECTION_ID]);
    expect(definition.steps[AGENT_RUNTIME_SECTION_ID]).toMatchObject({
      kind: "onTrigger",
      on: { type: "mail", to: "run_a@bench.example" },
    });
  });

  test("the section's body is one agent step carrying the per-turn timeout", () => {
    const section =
      buildAgentRuntimeWorkflow(sectionConfig).steps[AGENT_RUNTIME_SECTION_ID];

    expect(section).toMatchObject({
      body: {
        inline: {
          id: "wf_run_a_body",
          steps: {
            [AGENT_RUNTIME_TURN_STEP_ID]: {
              kind: "step",
              timeout: 45_000,
              agent: { systemPrompt: "You are helpful." },
            },
          },
        },
      },
    });
  });

  test("authors onBodyFailure 'continue' so a failed turn re-arms the section", () => {
    const section =
      buildAgentRuntimeWorkflow(sectionConfig).steps[AGENT_RUNTIME_SECTION_ID];

    expect(section).toMatchObject({ onBodyFailure: "continue" });
  });

  test("the section's failure policy survives the live→inert projection", () => {
    const projected = projectLiveToInert(
      buildAgentRuntimeWorkflow(sectionConfig),
    );
    const section = projected.steps[AGENT_RUNTIME_SECTION_ID];

    expect(section).toMatchObject({
      kind: "onTrigger",
      onBodyFailure: "continue",
    });
  });

  test("the mode alone selects the shape — same config fields, different definition", () => {
    const asStep = buildAgentRuntimeWorkflow(baseConfig);
    const asSection = buildAgentRuntimeWorkflow(sectionConfig);

    expect(asStep.steps[AGENT_RUNTIME_STEP_ID]?.kind).toBe("step");
    expect(asSection.steps[AGENT_RUNTIME_SECTION_ID]?.kind).toBe("onTrigger");
    expect(asStep.id).toBe(asSection.id);
  });
});

describe("agentRuntimeTurnRunId", () => {
  test("matches the runtime's <sectionId>__<occurrence> child-run scheme", () => {
    expect(agentRuntimeTurnRunId(0)).toBe(`${AGENT_RUNTIME_SECTION_ID}__0`);
    expect(agentRuntimeTurnRunId(7)).toBe(`${AGENT_RUNTIME_SECTION_ID}__7`);
  });

  test("rejects a non-integer or negative occurrence", () => {
    expect(() => agentRuntimeTurnRunId(-1)).toThrow();
    expect(() => agentRuntimeTurnRunId(1.5)).toThrow();
  });
});
