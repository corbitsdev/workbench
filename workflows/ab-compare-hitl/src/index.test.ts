import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
} from "@workbench/agents";

import { workflow } from "./index";

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: { id: string; input: unknown }[];
} {
  const ran: { id: string; input: unknown }[] = [];
  const invoker: StepInvoker = async ({ agent, input }) => {
    ran.push({ id: agent.id, input });
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

const VARIANT_A = {
  label: "Variant 1",
  providerName: "anthropic",
  model: "claude",
  input: "rewrite it",
};
const VARIANT_B = {
  label: "Variant 2",
  providerName: "openai",
  model: "gpt",
  input: "rewrite it",
};

describe("ab-compare-hitl native workflow", () => {
  test("gates on config, fans out execute, gates on the human decision, composes, then persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "hitl-ab-execute": { reply: "an answer" },
      "hitl-ab-compose": { content: '{"ranking":[],"variants":[]}' },
      "hitl-ab-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("ab-config", {
      variants: [VARIANT_A, VARIANT_B],
      input: "rewrite it",
    });
    await run.signal("ab-decision", {
      ranking: [
        { rank: 1, label: "Variant 2", rationale: "better close" },
        { rank: 2, label: "Variant 1" },
      ],
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds.filter((id) => id === "hitl-ab-execute")).toHaveLength(2);
    expect(ranIds).toContain("hitl-ab-compose");
    expect(ranIds).toContain("hitl-ab-persist");
    // No agent judge in the HITL flow.
    expect(ranIds).not.toContain("hitl-ab-compare");

    const signalNames = result.events
      .filter((e) => e.kind === "SignalReceived")
      .map((e) => ("signalName" in e ? e.signalName : undefined));
    expect(signalNames).toContain("ab-config");
    expect(signalNames).toContain("ab-decision");
  });

  test("has no agent compare step — the decision is a human signal", () => {
    expect(workflow.steps.compare).toBeUndefined();

    const decision = workflow.steps.decision;
    if (decision === undefined || decision.kind !== "awaitSignal") {
      throw new Error("expected an awaitSignal primitive for decision");
    }
    expect(decision.name).toBe("ab-decision");
    expect(decision.after).toContain("execute");
  });

  test("execute is an inline-inference map over the config variants", () => {
    const execute = workflow.steps.execute;
    if (execute === undefined || execute.kind !== "map") {
      throw new Error("expected a map primitive for execute");
    }
    expect(execute.over).toEqual({ from: "steps.config.output.variants" });
    expect(execute.step.agent.tags?.[STEP_KIND_TAG]).toBe(
      INLINE_INFERENCE_KIND,
    );
  });

  test("compose folds the whole steps tree via ab_comparison_compose after the decision", () => {
    const compose = workflow.steps.compose;
    if (compose === undefined || compose.kind !== "step") {
      throw new Error("expected a step primitive for compose");
    }
    expect(compose.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(compose.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "ab_comparison_compose",
    );
    expect(compose.input).toEqual({ from: "steps" });
    expect(compose.after).toContain("decision");
  });

  test("persist writes an ab-comparison artifact from the compose output", () => {
    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("artifact_create");
    expect(persist.input).toEqual({ from: "steps.compose.output" });
    expect(persist.after).toContain("compose");
    const argMapTag = persist.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error("expected an argMap tag");
    expect(JSON.parse(argMapTag)).toEqual({
      content: { from: "content" },
      title: { literal: "A/B Comparison Results" },
      kind: { literal: "ab-comparison" },
    });
  });
});
