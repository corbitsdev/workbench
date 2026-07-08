import { describe, expect, it } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_KIND_TAG,
} from "./deterministic-step";
import { classifyWorkflowSteps, countHumanGates } from "./flow-classify";

function stepAgent(tag?: string) {
  return {
    agent: {
      id: "a",
      tags: tag === undefined ? {} : { [STEP_KIND_TAG]: tag },
    },
  };
}

function makeDefinition(): WorkflowDefinition {
  return {
    id: "wf",
    triggers: [],
    stepOrder: ["fetch_sources", "synthesize_brief", "reviewDraft", "publish"],
    steps: {
      fetch_sources: {
        kind: "step",
        id: "fetch_sources",
        ...stepAgent(DETERMINISTIC_TOOL_KIND),
      },
      synthesize_brief: {
        kind: "step",
        id: "synthesize_brief",
        ...stepAgent(INLINE_INFERENCE_KIND),
      },
      reviewDraft: {
        kind: "awaitSignal",
        id: "reviewDraft",
        name: "review draft",
      },
      publish: {
        kind: "step",
        id: "publish",
        ...stepAgent(DETERMINISTIC_TOOL_KIND),
      },
    },
  } as unknown as WorkflowDefinition;
}

describe("classifyWorkflowSteps", () => {
  it("classifies steps in stepOrder with the right kinds and titles", () => {
    const steps = classifyWorkflowSteps(makeDefinition());
    expect(steps).toEqual([
      { id: "fetch_sources", title: "Fetch Sources", kind: "auto" },
      { id: "synthesize_brief", title: "Synthesize Brief", kind: "agent" },
      { id: "reviewDraft", title: "Review Draft", kind: "human" },
      { id: "publish", title: "Publish", kind: "auto" },
    ]);
  });

  it("treats an untagged plain step as a reasoning agent step", () => {
    const def = {
      id: "wf",
      triggers: [],
      stepOrder: ["think"],
      steps: { think: { kind: "step", id: "think", ...stepAgent() } },
    } as unknown as WorkflowDefinition;
    expect(classifyWorkflowSteps(def)[0]!.kind).toBe("agent");
  });

  it("classifies a map by its inner step's tag", () => {
    const def = {
      id: "wf",
      triggers: [],
      stepOrder: ["fanout"],
      steps: {
        fanout: {
          kind: "map",
          id: "fanout",
          step: {
            kind: "step",
            id: "inner",
            ...stepAgent(INLINE_INFERENCE_KIND),
          },
        },
      },
    } as unknown as WorkflowDefinition;
    expect(classifyWorkflowSteps(def)[0]!.kind).toBe("agent");
  });

  it("counts human gates", () => {
    expect(countHumanGates(classifyWorkflowSteps(makeDefinition()))).toBe(1);
  });
});
