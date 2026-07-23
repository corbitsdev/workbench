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

  test("defineWorkflow succeeds with exactly the discover/digest/persist steps", () => {
    expect(workflow.id).toBe("granola-call");
    const stepIds = Object.keys(workflow.steps);
    expect(stepIds.sort()).toEqual(["digest", "discover", "persist"]);
  });

  test("trigger is manual — no noteId, no signal gate; maxCalls is the only intake field", () => {
    expect(workflow.triggers).toEqual([{ type: "manual" }]);
    expect(INTAKE_FIELDS).toHaveLength(1);
    expect(INTAKE_FIELDS[0].name).toBe("maxCalls");
    expect(INTAKE_FIELDS[0].required).toBe(false);
  });

  test("discover reads maxCalls (renamed to the tool's `limit` arg) and never throws when absent", () => {
    const discover = stepPrimitive("discover");
    expect(discover.agent.tags?.["workbench.tool"]).toContain(
      "granola_list_notes",
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

  test("digest is a native reasoning step (no Workbench dispatch tag) fed by discover", () => {
    const digest = stepPrimitive("digest");
    expect(digest.agent.tags?.["workbench.stepKind"]).toBeUndefined();
    expect(digest.after).toEqual(expect.arrayContaining(["discover"]));
  });

  test("persist saves the digest under a stable sourceRef (idempotent — a quiet run does not duplicate)", () => {
    const persist = stepPrimitive("persist");
    expect(persist.agent.tags?.["workbench.tool"]).toContain("write_artifact");
    const argMapTag = persist.agent.tags?.["workbench.argMap"];
    expect(argMapTag).toBeDefined();
    const argMap = JSON.parse(argMapTag as string) as Record<string, unknown>;
    expect(argMap.sourceRef).toEqual({ literal: "granola-call-digest" });
    expect(argMap.body).toEqual({ from: "content" });
    expect(persist.after).toEqual(expect.arrayContaining(["digest"]));
  });

  test("display steps cover the flow", () => {
    expect(DISPLAY_STEPS.map((s) => s.key)).toEqual([
      "discover",
      "digest",
      "persist",
    ]);
  });
});
