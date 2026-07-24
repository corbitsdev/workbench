import { describe, expect, test } from "bun:test";
import { workflow, kind, label, description, INTAKE_FIELDS } from "./index";
import { DISPLAY_STEPS } from "./display-steps";

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("granola-call workflow", () => {
  test("exports kind/label/description", () => {
    expect(kind).toBe("granola-call");
    expect(label).toBe("Granola Call Processing");
    expect(description.length).toBeGreaterThan(20);
  });

  test("defineWorkflow succeeds with exactly the discover/spawn steps", () => {
    expect(workflow.id).toBe("granola-call");
    expect(Object.keys(workflow.steps).sort()).toEqual(["discover", "spawn"]);
  });

  test("trigger is manual — maxCalls is the only intake field", () => {
    expect(workflow.triggers).toEqual([{ type: "manual" }]);
    expect(INTAKE_FIELDS).toHaveLength(1);
    expect(INTAKE_FIELDS[0].name).toBe("maxCalls");
    expect(INTAKE_FIELDS[0].required).toBe(false);
  });

  test("discover reads maxCalls (renamed to the tool's `limit` arg) and never throws when absent", () => {
    const discover = stepPrimitive("discover");
    expect(discover.agent.tags?.["workbench.tool"]).toBe(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
    const argMapTag = discover.agent.tags?.["workbench.argMap"];
    expect(argMapTag).toBeDefined();
    const argMap = JSON.parse(argMapTag as string) as Record<string, unknown>;
    expect(argMap.limit).toEqual({ from: "maxCalls", optional: true });
    // A run with genuinely no input (trigger.payload === {}) must not throw:
    // every argMap field here is `optional`, so an absent value is OMITTED
    // from the tool call, not a hard failure.
    for (const value of Object.values(argMap)) {
      expect((value as { optional?: boolean }).optional).toBe(true);
    }
  });

  test("spawn forwards discover's list content and the optional maxCalls cap", () => {
    const spawn = stepPrimitive("spawn");
    expect(spawn.agent.tags?.["workbench.tool"]).toBe(
      "@workbench/tools-granola/hub:granola_spawn_call_runs",
    );
    expect(spawn.after).toEqual(["discover"]);
    const argMap = JSON.parse(
      spawn.agent.tags?.["workbench.argMap"] as string,
    ) as Record<string, unknown>;
    // `content` is the discover ToolResult's JSON — REQUIRED: a missing
    // field must fail the step loudly, never spawn zero children silently.
    expect(argMap.content).toEqual({ from: "content" });
    expect(argMap.maxCalls).toEqual({ from: "maxCalls", optional: true });
  });

  test("every step is deterministic — the parent runs no inference", () => {
    for (const stepId of Object.keys(workflow.steps)) {
      const step = stepPrimitive(stepId);
      expect(step.agent.tags?.["workbench.stepKind"]).toBe(
        "deterministic-tool",
      );
      expect(step.agent.inference).toEqual({ sources: [] });
    }
  });

  test("display steps cover the flow", () => {
    expect(DISPLAY_STEPS.map((s) => s.key)).toEqual(["discover", "spawn"]);
    const displayed = new Set(DISPLAY_STEPS.flatMap((s) => s.stepIds));
    for (const stepId of Object.keys(workflow.steps)) {
      expect(displayed.has(stepId)).toBe(true);
    }
  });
});
