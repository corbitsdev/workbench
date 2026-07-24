import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveDisplayFlow } from "./derive-display-flow";

const WORKFLOW_DEFS_DIR = join(
  import.meta.dir,
  "../../../apps/hub/generated/workflow-defs",
);

function loadDef(kind: string): unknown {
  return JSON.parse(
    readFileSync(join(WORKFLOW_DEFS_DIR, `${kind}.json`), "utf8"),
  );
}

describe("deriveDisplayFlow", () => {
  test("derives granola-call's two deterministic steps in stepOrder", () => {
    const flow = deriveDisplayFlow(loadDef("granola-call"));

    expect(flow.steps.map((s) => s.stepId)).toEqual(["discover", "spawn"]);
    expect(flow.steps[0]).toMatchObject({
      stepId: "discover",
      label: "Discover recent calls",
      character: "deterministic",
      after: [],
    });
    expect(flow.steps[1]).toMatchObject({
      stepId: "spawn",
      label: "Start per-call processing",
      character: "deterministic",
      after: ["discover"],
    });
  });

  test("derives process-granola-call's mixed deterministic/reasoning steps", () => {
    const flow = deriveDisplayFlow(loadDef("process-granola-call"));

    expect(flow.steps.map((s) => s.stepId)).toEqual([
      "fetch",
      "transcript",
      "extract",
      "processed",
      "finalize",
      "persist",
    ]);

    const byId = new Map(flow.steps.map((s) => [s.stepId, s]));
    expect(byId.get("fetch")).toMatchObject({
      label: "Fetch the transcript",
      character: "deterministic",
      after: [],
    });
    expect(byId.get("transcript")).toMatchObject({
      label: "Save the raw transcript",
      character: "deterministic",
      after: ["fetch"],
    });
    expect(byId.get("extract")).toMatchObject({
      label: "Extract working notes",
      character: "reasoning",
      after: ["fetch"],
    });
    expect(byId.get("processed")).toMatchObject({
      label: "Save the working notes",
      character: "deterministic",
      after: ["extract"],
    });
    expect(byId.get("finalize")).toMatchObject({
      label: "Verify and write call notes",
      character: "reasoning",
      after: ["extract"],
    });
    expect(byId.get("persist")).toMatchObject({
      label: "Save the call notes",
      character: "deterministic",
      after: ["finalize"],
    });
  });

  test("falls back to a humanized step id when no workbench.title tag is present", () => {
    const flow = deriveDisplayFlow({
      kind: "untitled-example",
      definition: {
        id: "untitled-example",
        stepOrder: ["fetchUserProfile"],
        steps: {
          fetchUserProfile: {
            kind: "step",
            id: "fetchUserProfile",
            agent: { tags: {} },
          },
        },
      },
    });

    expect(flow.steps[0]).toMatchObject({
      stepId: "fetchUserProfile",
      label: "Fetch User Profile",
      character: "reasoning",
    });
  });

  test("classifies the gate/await/action/sleep/child primitive kinds", () => {
    const flow = deriveDisplayFlow({
      kind: "kinds-example",
      definition: {
        id: "kinds-example",
        stepOrder: ["decide", "wait", "pause", "spawnChild", "run"],
        steps: {
          decide: { kind: "gate", id: "decide" },
          wait: { kind: "awaitSignal", id: "wait", name: "approval" },
          pause: { kind: "sleep", id: "pause" },
          spawnChild: { kind: "childWorkflow", id: "spawnChild" },
          run: { kind: "action", id: "run" },
        },
      },
    });

    const byId = new Map(flow.steps.map((s) => [s.stepId, s.character]));
    expect(byId.get("decide")).toBe("gate");
    expect(byId.get("wait")).toBe("await");
    expect(byId.get("pause")).toBe("sleep");
    expect(byId.get("spawnChild")).toBe("child");
    expect(byId.get("run")).toBe("action");
  });

  test("throws when the input is not a persisted workflow definition", () => {
    expect(() => deriveDisplayFlow({ nope: true })).toThrow();
  });
});
