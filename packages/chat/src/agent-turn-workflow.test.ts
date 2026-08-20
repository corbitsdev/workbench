import { describe, expect, test } from "bun:test";

import {
  AGENT_TURN_BODY_STEP_ID,
  AGENT_TURN_SECTION_ID,
  agentTurnChildRunId,
  agentTurnWorkflowId,
  buildAgentTurnWorkflow,
} from "./agent-turn-workflow";

const INPUT = {
  workbenchId: "wb_1",
  agentAddress: "ins_echo1@acme.example",
  systemPrompt: "You answer questions.",
  inferencePreferences: [
    { provider: "anthropic", model: "claude-sonnet-5" },
  ] as const,
  turnTimeoutMs: 60_000,
};

describe("agentTurnChildRunId", () => {
  test("names the occurrence's child run the way the runtime does", () => {
    expect(agentTurnChildRunId(0)).toBe("turn__0");
    expect(agentTurnChildRunId(7)).toBe("turn__7");
  });

  test("rejects an occurrence that is not a non-negative integer", () => {
    expect(() => agentTurnChildRunId(-1)).toThrow();
    expect(() => agentTurnChildRunId(1.5)).toThrow();
  });
});

describe("agentTurnWorkflowId", () => {
  test("is keyed on both the agent and the workbench", () => {
    const here = agentTurnWorkflowId({
      workbenchId: "wb_1",
      agentAddress: "ins_echo1@acme.example",
    });
    const sameAgentElsewhere = agentTurnWorkflowId({
      workbenchId: "wb_2",
      agentAddress: "ins_echo1@acme.example",
    });
    const otherAgentHere = agentTurnWorkflowId({
      workbenchId: "wb_1",
      agentAddress: "ins_echo2@acme.example",
    });
    expect(here).not.toBe(sameAgentElsewhere);
    expect(here).not.toBe(otherAgentHere);
  });

  test("is a plain identifier — never carries an address's punctuation", () => {
    expect(
      agentTurnWorkflowId({
        workbenchId: "wb_1",
        agentAddress: "ins_echo1@acme.example",
      }),
    ).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("buildAgentTurnWorkflow", () => {
  test("its one step is an onTrigger section on the agent's own address", () => {
    const definition = buildAgentTurnWorkflow(INPUT);
    const steps = definition.steps as Record<string, { kind: string }>;
    expect(Object.keys(steps)).toEqual([AGENT_TURN_SECTION_ID]);
    const section = steps[AGENT_TURN_SECTION_ID] as unknown as {
      kind: string;
      on: { type: string; to: string };
    };
    expect(section.kind).toBe("onTrigger");
    expect(section.on).toEqual({
      type: "mail",
      to: "ins_echo1@acme.example",
    });
  });

  test("a failed turn never kills the section", () => {
    const section = (
      buildAgentTurnWorkflow(INPUT).steps as unknown as Record<
        string,
        { onBodyFailure?: string }
      >
    )[AGENT_TURN_SECTION_ID];
    expect(section?.onBodyFailure).toBe("continue");
  });

  test("the body is one agent step, authored inline for the deploy to materialize", () => {
    const section = (
      buildAgentTurnWorkflow(INPUT).steps as unknown as Record<
        string,
        { body: { inline?: { steps: Record<string, unknown> } } }
      >
    )[AGENT_TURN_SECTION_ID];
    const inline = section?.body.inline;
    expect(inline).toBeDefined();
    expect(Object.keys(inline?.steps ?? {})).toEqual([AGENT_TURN_BODY_STEP_ID]);
  });

  test("rejects the inputs that would deploy an unaddressable section", () => {
    expect(() =>
      buildAgentTurnWorkflow({ ...INPUT, agentAddress: "" }),
    ).toThrow();
    expect(() =>
      buildAgentTurnWorkflow({ ...INPUT, workbenchId: "" }),
    ).toThrow();
    expect(() =>
      buildAgentTurnWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
    ).toThrow();
  });
});
