import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import { canonicalizeToolNames } from "./tool-names";
import {
  deterministicToolStep,
  agentStep,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_TITLE_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
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

  test("fails the build, naming the step and the unresolvable tool, for an unknown tool name", () => {
    expect(() =>
      deterministicToolStep({
        id: "extractOrgIds",
        tool: "prospect_engine_extract_list_org_id",
      }),
    ).toThrow(/extractOrgIds/);
    expect(() =>
      deterministicToolStep({
        id: "extractOrgIds",
        tool: "prospect_engine_extract_list_org_id",
      }),
    ).toThrow(/prospect_engine_extract_list_org_id/);
  });

  test("passes a legitimate local-runner tool (mail_send) through unprefixed", () => {
    const primitive = deterministicToolStep({
      id: "notify",
      tool: "mail_send",
    });
    expect(primitive.agent.tags?.[STEP_TOOL_TAG]).toBe("mail_send");
    expect(primitive.agent.capabilities).toEqual(["mail_send"]);
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

  test("an argMap `from` spec may declare optional: true and round-trips through arktype", () => {
    const argMap = {
      artifactId: { from: "artifactId", optional: true },
    };
    const primitive = deterministicToolStep({
      id: "fetch-artifact",
      tool: "artifact_read",
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

  test("an argMap `fromJson` spec parses with a `field` and round-trips through arktype", () => {
    const argMap = {
      url: { fromJson: "content", field: "gammaUrl" },
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

  test("an argMap `fromJson` spec may declare optional: true and round-trips through arktype", () => {
    const argMap = {
      pdfUrl: { fromJson: "content", field: "exportUrl", optional: true },
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

describe("agentStep", () => {
  const SYSTEM_PROMPT = "You analyze a transcript and return JSON.";

  test("builds a plain native step carrying no Workbench dispatch tag", () => {
    const primitive = agentStep({
      id: "analyze",
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(primitive.kind).toBe("step");
    expect(primitive.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(primitive.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
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
