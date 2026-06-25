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

describe("ab-compare native workflow", () => {
  test("gates on config, fans out execute per variant, compares, gates on review, then persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "blind-ab-execute": { reply: "an answer" },
      "blind-ab-compare": { reply: '{"summary":"ok","ranking":[]}' },
      "blind-ab-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("ab-config", {
      variants: [VARIANT_A, VARIANT_B],
      input: "rewrite it",
    });
    await run.signal("comparison-review", { approved: true });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    // execute runs once per variant (2), then compare, then persist.
    expect(ranIds.filter((id) => id === "blind-ab-execute")).toHaveLength(2);
    expect(ranIds).toContain("blind-ab-compare");
    expect(ranIds).toContain("blind-ab-persist");

    // Each execute iteration receives one variant payload (not the whole array).
    const executeInputs = ran
      .filter((r) => r.id === "blind-ab-execute")
      .map((r) => r.input);
    expect(executeInputs).toEqual([VARIANT_A, VARIANT_B]);

    const signalNames = result.events
      .filter((e) => e.kind === "SignalReceived")
      .map((e) => ("signalName" in e ? e.signalName : undefined));
    expect(signalNames).toContain("ab-config");
    expect(signalNames).toContain("comparison-review");
  });

  test("config gate precedes the execute map", () => {
    const config = workflow.steps.config;
    if (config === undefined || config.kind !== "awaitSignal") {
      throw new Error("expected an awaitSignal primitive for config");
    }
    expect(config.name).toBe("ab-config");

    const execute = workflow.steps.execute;
    if (execute === undefined || execute.kind !== "map") {
      throw new Error("expected a map primitive for execute");
    }
    expect(execute.after).toContain("config");
  });

  test("execute maps over the config signal's variants array", () => {
    const execute = workflow.steps.execute;
    if (execute === undefined || execute.kind !== "map") {
      throw new Error("expected a map primitive for execute");
    }
    expect(execute.over).toEqual({ from: "steps.config.output.variants" });
  });

  test("execute inner step is an inline-inference turn reading the per-variant payload", () => {
    const execute = workflow.steps.execute;
    if (execute === undefined || execute.kind !== "map") {
      throw new Error("expected a map primitive for execute");
    }
    const inner = execute.step;
    expect(inner.agent.id).toBe("blind-ab-execute");
    expect(inner.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(inner.agent.capabilities).toEqual([]);
    expect(inner.agent.inference.sources).toEqual([]);
    expect(inner.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(inner.input).toEqual({ from: "trigger.payload" });
  });

  test("compare is an inline-inference step reading the execute map output", () => {
    const compare = workflow.steps.compare;
    if (compare === undefined || compare.kind !== "step") {
      throw new Error("expected a step primitive for compare");
    }
    expect(compare.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(compare.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(compare.agent.capabilities).toEqual([]);
    expect(compare.agent.inference.sources).toEqual([]);
    expect(compare.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(compare.input).toEqual({ from: "steps.execute.output" });
    expect(compare.after).toContain("execute");
  });

  test("review signal gates between compare and persist", () => {
    const review = workflow.steps.review;
    if (review === undefined || review.kind !== "awaitSignal") {
      throw new Error("expected an awaitSignal primitive for review");
    }
    expect(review.name).toBe("comparison-review");
    expect(review.after).toContain("compare");

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.after).toContain("review");
  });

  test("persist is a deterministic artifact_create step with an argMap, not inference", () => {
    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("artifact_create");
    expect(persist.agent.inference.sources).toEqual([]);
    expect(persist.input).toEqual({ from: "steps.compare.output" });
    const argMapTag = persist.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error("expected an argMap tag");
    expect(JSON.parse(argMapTag)).toEqual({
      content: { from: "reply" },
      title: { literal: "A/B Comparison Results" },
      kind: { literal: "document" },
    });
  });
});
