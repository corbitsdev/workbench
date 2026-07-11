import { describe, expect, it } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_KIND_TAG,
  STEP_TITLE_TAG,
} from "./deterministic-step";
import { classifyWorkflowSteps, countHumanGates } from "./flow-classify";

function stepAgent(tag?: string, title?: string) {
  const tags: Record<string, string> = {};
  if (tag !== undefined) tags[STEP_KIND_TAG] = tag;
  if (title !== undefined) tags[STEP_TITLE_TAG] = title;
  return { agent: { id: "a", tags } };
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

  it("prefers an authored title tag over the humanized id", () => {
    const def = {
      id: "wf",
      triggers: [],
      stepOrder: ["webB"],
      steps: {
        webB: {
          kind: "step",
          id: "webB",
          ...stepAgent(DETERMINISTIC_TOOL_KIND, "Search the web (round 2)"),
        },
      },
    } as unknown as WorkflowDefinition;
    expect(classifyWorkflowSteps(def)[0]!.title).toBe(
      "Search the web (round 2)",
    );
  });

  it("reads the title tag off a map's inner step", () => {
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
            ...stepAgent(DETERMINISTIC_TOOL_KIND, "Fan out across sources"),
          },
        },
      },
    } as unknown as WorkflowDefinition;
    expect(classifyWorkflowSteps(def)[0]!.title).toBe("Fan out across sources");
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

  it("projects onto a declared display flow: one entry per group, labelled", () => {
    const steps = classifyWorkflowSteps(makeDefinition(), [
      {
        key: "gather",
        label: "Gather",
        stepIds: ["fetch_sources", "synthesize_brief"],
      },
      { key: "approve", label: "Approve", stepIds: ["reviewDraft", "publish"] },
    ]);
    expect(steps).toEqual([
      { id: "gather", title: "Gather", kind: "agent" },
      { id: "approve", title: "Approve", kind: "human" },
    ]);
  });

  it("aggregates a group's kind as human > agent > auto", () => {
    const [autoOnly] = classifyWorkflowSteps(makeDefinition(), [
      { key: "a", label: "A", stepIds: ["fetch_sources", "publish"] },
    ]);
    expect(autoOnly!.kind).toBe("auto");
  });

  it("tolerates a declared stepId that is not a real step", () => {
    const [group] = classifyWorkflowSteps(makeDefinition(), [
      { key: "g", label: "G", stepIds: ["fetch_sources", "ghost"] },
    ]);
    // The missing id is skipped; the group still classifies from its real steps.
    expect(group).toEqual({ id: "g", title: "G", kind: "auto" });
  });

  it("falls back to the per-step projection for an empty display flow", () => {
    const grouped = classifyWorkflowSteps(makeDefinition(), []);
    const fallback = classifyWorkflowSteps(makeDefinition());
    expect(grouped).toEqual(fallback);
  });
});
