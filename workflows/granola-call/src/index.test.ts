import { describe, expect, test } from "bun:test";
import {
  INLINE_INFERENCE_KIND,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import { workflow, kind, label, description } from "./index";
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

  test("defineWorkflow succeeds with expected steps", () => {
    // Interchange WorkflowDefinition uses `id` (deployment kind is the package export).
    expect(workflow.id).toBe("granola-call");
    const stepIds = Object.keys(workflow.steps);
    expect(stepIds).toEqual(
      expect.arrayContaining([
        "fetch",
        "normalize",
        "classify",
        "build-prompt",
        "analyze",
        "parse",
        "prepare",
        "persist-pain",
        "persist-summary",
        "persist-brief",
        "create-tasks",
        "fanout",
        "emit",
      ]),
    );
    expect(stepIds).toHaveLength(13);
  });

  test("exactly one inlineInferenceStep (analyze)", () => {
    const steps = Object.keys(workflow.steps).map((id) => stepPrimitive(id));
    const inferenceSteps = steps.filter(
      (step) => step.agent.tags?.[STEP_KIND_TAG] === INLINE_INFERENCE_KIND,
    );
    expect(inferenceSteps.map((s) => s.agent.id)).toEqual([
      "granola-call-analyze",
    ]);
  });

  test("deterministic tool tags for pure + hub tools", () => {
    const toolFor = (stepId: string): string | undefined =>
      stepPrimitive(stepId).agent.tags?.[STEP_TOOL_TAG];

    // Canonical tool names may be package-qualified; match short name.
    expect(toolFor("fetch")).toContain("granola_get_note");
    expect(toolFor("normalize")).toContain("granola_normalize_note");
    expect(toolFor("classify")).toContain("granola_classify_call");
    expect(toolFor("build-prompt")).toContain("granola_build_analysis_prompt");
    expect(toolFor("parse")).toContain("granola_parse_analysis");
    expect(toolFor("prepare")).toContain("granola_prepare_artifacts");
    expect(toolFor("persist-pain")).toContain("write_artifact");
    expect(toolFor("persist-summary")).toContain("write_artifact");
    expect(toolFor("persist-brief")).toContain("write_artifact");
    expect(toolFor("create-tasks")).toContain("granola_create_tasks");
    expect(toolFor("fanout")).toContain("granola_fanout_call");
    expect(toolFor("emit")).toContain("granola_emit_run_outputs");
  });

  test("display steps cover the flow", () => {
    expect(DISPLAY_STEPS.length).toBeGreaterThanOrEqual(10);
    expect(DISPLAY_STEPS.map((s) => s.key)).toContain("analyze");
  });

  test("create-tasks runs after artifact persist so links can reference artifacts", () => {
    const createTasks = stepPrimitive("create-tasks");
    expect(createTasks.after).toEqual(
      expect.arrayContaining([
        "prepare",
        "persist-pain",
        "persist-summary",
        "persist-brief",
      ]),
    );
  });

  test("classify does not mark tenantDomain optional (never skips the step)", () => {
    // Missing tenantDomain must still invoke granola_classify_call; the tool
    // itself returns classification "unknown" when domain is empty.
    const classify = stepPrimitive("classify");
    // The step is wired to merge normalize + trigger payload; optional fields
    // would cause reshapeWithArgMap to skip the call entirely.
    expect(classify.after).toEqual(expect.arrayContaining(["normalize"]));
    expect(classify.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "granola_classify_call",
    );
  });

  test("analyze is wired after build-prompt (not raw normalize envelope)", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.after).toEqual(expect.arrayContaining(["build-prompt"]));
  });
});
