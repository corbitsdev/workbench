import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import { canonicalizeToolNames } from "./tool-names";
import {
  deterministicToolStep,
  inlineInferenceStep,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  ArgMap,
} from "./deterministic-step";

describe("deterministicToolStep", () => {
  test("marks the placeholder agent with the deterministic dispatch tags", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
    });
    const [canonical] = canonicalizeToolNames(["gamma_create_from_template"]);
    if (canonical === undefined)
      throw new Error("expected a canonical tool name");
    expect(primitive.kind).toBe("step");
    expect(primitive.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(primitive.agent.tags?.[STEP_TOOL_TAG]).toBe(canonical);
  });

  test("carries no inference source so the reactor never runs", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
    });
    expect(primitive.agent.inference.sources).toEqual([]);
  });

  test("keeps the canonical tool in capabilities so grants + manifest pin it", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
    });
    const [canonical] = canonicalizeToolNames(["gamma_create_from_template"]);
    if (canonical === undefined)
      throw new Error("expected a canonical tool name");
    expect(primitive.agent.capabilities).toEqual([canonical]);
    expect(primitive.agent.capabilities[0]).toBe(
      primitive.agent.tags?.[STEP_TOOL_TAG],
    );
  });

  test("omits the non-fatal tag by default (a failing step fails the run)", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
    });
    expect(primitive.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
  });

  test("marks the non-fatal tag when nonFatal is set so a throw degrades to a skip", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
      nonFatal: true,
    });
    expect(primitive.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
  });

  test("omits the argMap tag when no argMap is supplied", () => {
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
    });
    expect(primitive.agent.tags?.[STEP_ARGMAP_TAG]).toBeUndefined();
  });

  test("serializes the argMap onto the tag and it round-trips through arktype", () => {
    const argMap = {
      gammaId: { from: "gammaId" },
      prompt: { from: "reply" },
      title: { literal: "A/B Comparison Results" },
    };
    const primitive = deterministicToolStep({
      id: "render",
      tool: "gamma_create_from_template",
      argMap,
    });
    const raw = primitive.agent.tags?.[STEP_ARGMAP_TAG];
    if (raw === undefined) throw new Error("expected an argMap tag");
    const parsed = ArgMap(JSON.parse(raw));
    if (parsed instanceof type.errors) {
      throw new Error(`argMap failed to round-trip: ${parsed.summary}`);
    }
    expect(parsed).toEqual(argMap);
  });

  test("uses the supplied id and dependency edges", () => {
    const primitive = deterministicToolStep({
      id: "presentation-render",
      tool: "gamma_create_from_template",
      after: ["review"],
    });
    expect(primitive.agent.id).toBe("presentation-render");
    expect(primitive.after).toEqual(["review"]);
  });
});

describe("inlineInferenceStep", () => {
  const SYSTEM_PROMPT = "You analyze a transcript and return JSON.";

  test("marks the placeholder agent with the inline-inference dispatch tag", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.kind).toBe("step");
    expect(primitive.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
  });

  test("does NOT carry the deterministic-tool marker tags", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.agent.tags?.[STEP_KIND_TAG]).not.toBe(
      DETERMINISTIC_TOOL_KIND,
    );
    expect(primitive.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(primitive.agent.tags?.[STEP_ARGMAP_TAG]).toBeUndefined();
  });

  test("keeps the real system prompt (this is genuine reasoning)", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.agent.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  test("declares no tools/capabilities and no inference source in the definition", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    // No tools: the source is pinned at deploy time and resolved by the
    // sidecar from STEP_INFERENCE_SOURCES, not declared on the definition.
    expect(primitive.agent.capabilities).toEqual([]);
    expect(primitive.agent.toolFactories).toEqual([]);
    expect(primitive.agent.inference.sources).toEqual([]);
  });

  test("uses the supplied id, input, and dependency edges", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
      input: { from: "steps.fetch.output" },
      after: ["context"],
    });
    expect(primitive.agent.id).toBe("analyze");
    expect(primitive.input).toEqual({ from: "steps.fetch.output" });
    expect(primitive.after).toEqual(["context"]);
  });
});
