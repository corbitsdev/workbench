import { describe, test, expect } from "bun:test";
import { agentStep, STEP_TITLE_TAG } from "./deterministic-step";

describe("agentStep", () => {
  const SYSTEM_PROMPT = "You analyze a transcript and return JSON.";

  test("builds a plain native step carrying no Workbench dispatch tag", () => {
    const primitive = agentStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.kind).toBe("step");
    expect(primitive.agent.tags?.["workbench.stepKind"]).toBeUndefined();
  });

  test("adds canonical Corbits terminology without replacing the supplied prompt", () => {
    const primitive = agentStep({ id: "analyze", systemPrompt: SYSTEM_PROMPT });
    expect(primitive.agent.systemPrompt).toContain(SYSTEM_PROMPT);
    expect(primitive.agent.systemPrompt).toContain(
      "Corbits, Corbits.dev, Interchange, and Faremeter",
    );
  });

  test("declares no tools/capabilities and no inference source by default", () => {
    const primitive = agentStep({ id: "analyze", systemPrompt: SYSTEM_PROMPT });
    expect(primitive.agent.capabilities).toEqual([]);
    expect(primitive.agent.toolFactories).toEqual([]);
    expect(primitive.agent.inference.sources).toEqual([]);
  });

  test("uses the supplied id, input, and dependency edges", () => {
    const primitive = agentStep({
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
    const primitive = agentStep({
      id: "writer",
      systemPrompt: SYSTEM_PROMPT,
      model: "kimi-k2.6",
    });
    expect(primitive.agent.inference.sources).toEqual([
      { provider: "openai-compatible", model: "kimi-k2.6" },
    ]);
  });

  test("a non-default provider is declared alongside the model", () => {
    const primitive = agentStep({
      id: "quality-opus",
      systemPrompt: SYSTEM_PROMPT,
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(primitive.agent.inference.sources).toEqual([
      { provider: "anthropic", model: "claude-opus-4-8" },
    ]);
  });

  test("maxTokens rides on the preferred source's parameters", () => {
    const primitive = agentStep({
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

  test("retry policy is threaded onto the underlying step", () => {
    const retry = { maxAttempts: 3, initialBackoffMs: 500 };
    const primitive = agentStep({
      id: "writer",
      systemPrompt: SYSTEM_PROMPT,
      retry,
    });
    expect(primitive.retry).toEqual(retry);
  });

  test("an authored title sets the shared title tag and nothing else", () => {
    const primitive = agentStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
      title: "Find the pain points",
    });
    expect(primitive.agent.tags).toEqual({
      [STEP_TITLE_TAG]: "Find the pain points",
    });
  });

  test("no title leaves tags undefined", () => {
    const primitive = agentStep({ id: "analyze", systemPrompt: SYSTEM_PROMPT });
    expect(primitive.agent.tags).toBeUndefined();
  });
});
