import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import {
  projectWorkflow,
  type ProjectedStep,
  type ProjectedWorkflow,
} from "./projection";

function stepOf(p: ProjectedWorkflow, id: string): ProjectedStep {
  const step = p.steps[id];
  if (!step) throw new Error(`step "${id}" missing from projection`);
  return step;
}

// A minimal hand-built definition shaped like the read-back JSON from
// readWorkflowDefinition (deterministic steps carry the workbench tags; a
// reasoning step is a plain step({agent}) with an inference source).
function definition(): WorkflowDefinition {
  return {
    id: "demo",
    triggers: [],
    stepOrder: ["intake", "select", "analyze", "generate"],
    steps: {
      intake: {
        kind: "step",
        id: "intake",
        agent: {
          id: "intake-agent",
          tags: {
            [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND,
            [STEP_TOOL_TAG]: "granola_list_notes",
          },
          inference: { sources: [] },
        },
        input: { literal: {} },
      },
      select: {
        kind: "awaitSignal",
        id: "select",
        name: "note-selection",
        after: ["intake"],
      },
      analyze: {
        kind: "step",
        id: "analyze",
        agent: {
          id: "analyze-agent",
          systemPrompt: "extract pain points",
          tags: { credentialName: "opencode-zen" },
          inference: {
            sources: [
              { provider: "openai-compatible", model: "deepseek-v4-flash" },
            ],
          },
        },
        input: { from: "steps.select.output" },
        after: ["select"],
      },
      generate: {
        kind: "map",
        id: "generate",
        over: { from: "steps.analyze.output.items" },
        step: {
          kind: "step",
          id: "persist",
          agent: {
            id: "persist-agent",
            tags: {
              [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND,
              [STEP_TOOL_TAG]: "artifact_create",
              [STEP_ARGMAP_TAG]: JSON.stringify({
                title: { from: "title" },
                kind: { literal: "document" },
              }),
            },
            inference: { sources: [] },
          },
          input: { from: "trigger.payload" },
        },
        after: ["analyze"],
      },
      // arktype-shaped definitions allow extra keys; cast at the test boundary.
    } as unknown as WorkflowDefinition["steps"],
  };
}

describe("projectWorkflow", () => {
  test("projects a deterministic step into a tool step", () => {
    const p = projectWorkflow(definition());
    const intake = stepOf(p, "intake");
    expect(intake.kind).toBe("tool");
    if (intake.kind !== "tool") throw new Error("unreachable");
    expect(intake.tool).toBe("granola_list_notes");
    expect(intake.input).toEqual({ literal: {} });
  });

  test("projects awaitSignal into a gate carrying the signal name", () => {
    const p = projectWorkflow(definition());
    const select = stepOf(p, "select");
    expect(select.kind).toBe("gate");
    if (select.kind !== "gate") throw new Error("unreachable");
    expect(select.signalName).toBe("note-selection");
  });

  test("projects a plain agent step into a reasoning step with source + credentialName", () => {
    const p = projectWorkflow(definition());
    const analyze = stepOf(p, "analyze");
    expect(analyze.kind).toBe("reasoning");
    if (analyze.kind !== "reasoning") throw new Error("unreachable");
    expect(analyze.source).toEqual({
      provider: "openai-compatible",
      model: "deepseek-v4-flash",
    });
    expect(analyze.credentialName).toBe("opencode-zen");
    expect(analyze.systemPrompt).toBe("extract pain points");
  });

  test("projects a map step, parsing the child argMap from its tag", () => {
    const p = projectWorkflow(definition());
    const generate = stepOf(p, "generate");
    expect(generate.kind).toBe("map");
    if (generate.kind !== "map") throw new Error("unreachable");
    expect(generate.over).toEqual({ from: "steps.analyze.output.items" });
    expect(generate.child.kind).toBe("tool");
    if (generate.child.kind !== "tool") throw new Error("unreachable");
    expect(generate.child.tool).toBe("artifact_create");
    expect(generate.child.argMap).toEqual({
      title: { from: "title" },
      kind: { literal: "document" },
    });
  });

  test("preserves stepOrder for the executor walk", () => {
    const p = projectWorkflow(definition());
    expect(p.order).toEqual(["intake", "select", "analyze", "generate"]);
  });

  test("throws on an unsupported step kind", () => {
    const def = definition();
    (def.steps as Record<string, unknown>).bad = {
      kind: "sleep",
      id: "bad",
      duration: 1,
    };
    (def as unknown as { stepOrder: string[] }).stepOrder = [
      ...def.stepOrder,
      "bad",
    ];
    expect(() => projectWorkflow(def)).toThrow(/unsupported step kind "sleep"/);
  });
});
