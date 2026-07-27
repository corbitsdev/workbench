import { describe, expect, test } from "bun:test";
import {
  workflow,
  kind,
  label,
  description,
  INTAKE_FIELDS,
  GRANOLA_LIST_NOTES_HANDLER,
  GRANOLA_SPAWN_CALL_RUNS_HANDLER,
} from "./index";
import { DISPLAY_STEPS } from "./display-steps";

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
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

  test("trigger is manual — limit is the only intake field, named to match the tool args verbatim", () => {
    expect(workflow.triggers).toEqual([{ type: "manual" }]);
    expect(INTAKE_FIELDS).toHaveLength(1);
    expect(INTAKE_FIELDS[0].name).toBe("limit");
    expect(INTAKE_FIELDS[0].required).toBe(false);
  });

  test("discover is a native action calling granola_list_notes with trigger.payload passed through verbatim", () => {
    const discover = actionPrimitive("discover");
    expect(discover.handler).toBe(GRANOLA_LIST_NOTES_HANDLER);
    expect(GRANOLA_LIST_NOTES_HANDLER).toBe(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
    // No argMap/reshape anywhere on the primitive — the input selector IS
    // the tool call arguments.
    expect(discover.input).toEqual({ from: "trigger.payload" });
    expect(discover.effect).toEqual({
      requires: [GRANOLA_LIST_NOTES_HANDLER],
    });
  });

  test("spawn is a native action merging discover's content with trigger.payload's limit", () => {
    const spawn = actionPrimitive("spawn");
    expect(spawn.handler).toBe(GRANOLA_SPAWN_CALL_RUNS_HANDLER);
    expect(GRANOLA_SPAWN_CALL_RUNS_HANDLER).toBe(
      "@workbench/tools-granola/hub:granola_spawn_call_runs",
    );
    expect(spawn.after).toEqual(["discover"]);
    expect(spawn.input).toEqual({
      merge: [{ from: "steps.discover.output" }, { from: "trigger.payload" }],
    });
    expect(spawn.effect).toEqual({
      requires: [GRANOLA_SPAWN_CALL_RUNS_HANDLER],
    });
  });

  test("every step is a native action — no agent, no inference, in the parent", () => {
    for (const stepId of Object.keys(workflow.steps)) {
      const step = workflow.steps[stepId];
      expect(step?.kind).toBe("action");
      expect((step as { agent?: unknown }).agent).toBeUndefined();
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
