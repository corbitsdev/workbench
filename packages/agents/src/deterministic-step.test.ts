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

  test("adds canonical Corbits terminology without replacing the supplied prompt", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.agent.systemPrompt).toContain(SYSTEM_PROMPT);
    expect(primitive.agent.systemPrompt).toContain(
      "Corbits, Corbits.dev, Interchange, and Faremeter",
    );
    expect(primitive.agent.systemPrompt).toContain(
      "clear speech-to-text or spelling variant",
    );
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

  test("a model preference declares a matching preferred inference source", () => {
    const primitive = inlineInferenceStep({
      id: "writer",
      systemPrompt: SYSTEM_PROMPT,
      model: "kimi-k2.6",
    });
    // The orchestrator's pickStepInferenceSource matches by (provider, model)
    // against the deploy's config.sources, so the declared preference must carry
    // both — this is what routes the step to a non-default model.
    expect(primitive.agent.inference.sources).toEqual([
      { provider: "openai-compatible", model: "kimi-k2.6" },
    ]);
  });

  test("no model preference leaves the source list empty (rides the deploy default)", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.agent.inference.sources).toEqual([]);
  });

  test("a non-default provider is declared alongside the model (native-provider models)", () => {
    const primitive = inlineInferenceStep({
      id: "quality-opus",
      systemPrompt: SYSTEM_PROMPT,
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    // The A/B presets pin native-provider models (Opus via anthropic), not only
    // the openai-compatible gateway — the deploy matches on (provider, model).
    expect(primitive.agent.inference.sources).toEqual([
      { provider: "anthropic", model: "claude-opus-4-8" },
    ]);
  });

  test("nonFatal marks the step so a failed variant degrades instead of failing the run", () => {
    const primitive = inlineInferenceStep({
      id: "quality-opus",
      systemPrompt: SYSTEM_PROMPT,
      provider: "anthropic",
      model: "claude-opus-4-8",
      nonFatal: true,
    });
    expect(primitive.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
  });

  test("retry policy is threaded onto the underlying step", () => {
    const retry = { maxAttempts: 3, initialBackoffMs: 500 };
    const primitive = inlineInferenceStep({
      id: "quality-opus",
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-opus-4-8",
      provider: "anthropic",
      retry,
    });
    expect(primitive.retry).toEqual(retry);
  });

  test("maxTokens rides on the preferred source's parameters so the deploy can lift it onto defaults.maxTokens", () => {
    const primitive = inlineInferenceStep({
      id: "writer",
      systemPrompt: SYSTEM_PROMPT,
      model: "kimi-k2.6",
      maxTokens: 16384,
    });
    expect(primitive.agent.inference.sources).toEqual([
      {
        provider: "openai-compatible",
        model: "kimi-k2.6",
        parameters: { maxTokens: 16384 },
      },
    ]);
  });

  test("maxTokens without a model is ignored — no preferred source to carry it", () => {
    const primitive = inlineInferenceStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 16384,
    });
    expect(primitive.agent.inference.sources).toEqual([]);
  });
});
