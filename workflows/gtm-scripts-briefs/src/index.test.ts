import { describe, expect, test } from "bun:test";
import { LLM_WRITER_MODEL } from "@workbench/agents";
import { WORKFLOW_BRIEF_HANDLER } from "@workbench/workflow-last30days-research";
import {
  DISPLAY_STEPS,
  kind,
  PREPARE_PERSIST_HANDLER,
  workflow,
  WRITE_ARTIFACT_HANDLER,
} from "./index";

// The retired `deterministic-tool` authoring kind's tag. Kept as a literal
// (not an import from `@workbench/agents`, which no longer exports it) —
// this test only asserts the tag is ABSENT from every native step, proving
// no step regresses onto the deleted mechanism.
const STEP_KIND_TAG = "workbench.stepKind";

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

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
      "persist-prepare",
      "persist",
    ]);

    const brief = actionPrimitive("brief");
    expect(brief.handler).toBe(WORKFLOW_BRIEF_HANDLER);
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

    const persistPrepare = actionPrimitive("persist-prepare");
    expect(persistPrepare.handler).toBe(PREPARE_PERSIST_HANDLER);
    expect(PREPARE_PERSIST_HANDLER).toBe(
      "@workbench/workflow-gtm-scripts-briefs/core:gtm_scripts_briefs_prepare_persist",
    );
    expect(persistPrepare.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.write.output" },
        {
          literal: {
            workflowKind: kind,
            artifactKind: "long-form-script-package",
            jobLabel: "GTM scripts and briefs",
          },
        },
      ],
    });
    expect(persistPrepare.effect).toEqual({
      requires: [PREPARE_PERSIST_HANDLER],
    });
    expect(persistPrepare.after).toEqual(["write"]);

    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(persist.input).toEqual({
      from: "steps.persist-prepare.output.content",
    });
    expect(persist.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
    expect(persist.after).toEqual(["persist-prepare"]);
  });

  test("keeps the workflow identity stable", () => {
    expect(workflow.id).toBe(kind);
    expect(kind).toBe("gtm-scripts-briefs");
  });

  test("DISPLAY_STEPS covers every declared step exactly once", () => {
    const declared = DISPLAY_STEPS.flatMap((group) => group.stepIds);
    expect(declared.sort()).toEqual(Object.keys(workflow.steps).sort());
    expect(new Set(declared).size).toBe(declared.length);
  });
});
