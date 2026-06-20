import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import { canonicalizeToolNames } from "./tool-names";
import {
  deterministicToolStep,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
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
