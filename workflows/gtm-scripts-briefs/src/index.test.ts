import { describe, expect, test } from "bun:test";
import {
  LLM_WRITER_MODEL,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import { kind, workflow } from "./index";

describe("gtm-scripts-briefs workflow", () => {
  test("collects intake, reuses grounded research, then writes and persists", () => {
    const intake = workflow.steps.intake;
    if (intake === undefined || intake.kind !== "awaitSignal") {
      throw new Error("expected an intake signal");
    }
    expect(intake.name).toBe("intake");
    expect(Object.keys(workflow.steps)).toEqual([
      "intake",
      "ground",
      "groundQueries",
      "web",
      "webB",
      "webC",
      "hackernews",
      "github",
      "reddit",
      "x",
      "youtube",
      "polymarket",
      "entities",
      "entityQueries",
      "web2",
      "reddit2",
      "x2",
      "youtube2",
      "collect",
      "curate",
      "brief",
      "write",
      "persist",
    ]);

    const brief = workflow.steps.brief;
    if (brief === undefined || brief.kind !== "step") {
      throw new Error("expected a grounded story brief");
    }
    expect(brief.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "last30days_workflow_brief",
    );
    expect(brief.after).toEqual(["curate"]);
  });

  test("writes from the selected research brief and persists its lineage", () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== "step") {
      throw new Error("expected a write step");
    }
    expect(write.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(write.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    expect(write.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 16384,
    });
    expect(write.after).toEqual(["brief"]);

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a persist step");
    }
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    expect(persist.after).toEqual(["write"]);
    expect(JSON.parse(persist.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
      title: { from: "topic" },
      body: { from: "reply" },
      kind: { literal: "long-form-script-package" },
      data: {
        object: {
          workflowKind: { literal: kind },
          topic: { from: "topic" },
          days: { from: "days" },
          audience: { from: "audience", optional: true },
          objective: { from: "objective", optional: true },
          artifactKind: { literal: "long-form-script-package" },
        },
      },
      jobLabel: { literal: "GTM scripts and briefs" },
    });
  });

  test("keeps the workflow identity stable", () => {
    expect(workflow.id).toBe(kind);
    expect(kind).toBe("gtm-scripts-briefs");
  });
});
