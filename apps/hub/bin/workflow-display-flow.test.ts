import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import { classifyWorkflowSteps } from "@workbench/agents";
import { workflowKinds } from "./build-workflow-defs";
import { resolveWorkflowEntry } from "./deploy-workflow";

// A workflow's declared user-facing flow: the browser-safe DISPLAY_STEPS export.
// Only the serializable subset the classifier reads is needed here.
type DeclaredDisplayStep = {
  key: string;
  label: string;
  stepIds: readonly string[];
};

type WorkflowModule = {
  workflow: WorkflowDefinition;
  DISPLAY_STEPS?: readonly DeclaredDisplayStep[];
};

async function loadModule(kind: string): Promise<WorkflowModule> {
  const mod: unknown = await import(resolveWorkflowEntry(kind));
  return mod as WorkflowModule;
}

// Every workflow that ships a client run panel declares a DISPLAY_STEPS flow;
// this test binds the server catalog preview to that same declaration so the two
// surfaces cannot drift. A workflow with no declaration (generic STEP_ORDER path)
// is exercised by the fallback case below.
const kinds = workflowKinds();

describe("workflow display-flow declaration ↔ catalog preview", () => {
  test("at least one workflow declares a display flow", async () => {
    const declaring: string[] = [];
    for (const kind of kinds) {
      const mod = await loadModule(kind);
      if (mod.DISPLAY_STEPS !== undefined) declaring.push(kind);
    }
    expect(declaring.length).toBeGreaterThan(0);
  });

  for (const kind of kinds) {
    test(`${kind}: declared flow drives the classified preview`, async () => {
      const mod = await loadModule(kind);
      const declared = mod.DISPLAY_STEPS;
      if (declared === undefined) {
        // Generic workflow: no declaration → the classifier falls back to the
        // per-execution-step projection over stepOrder.
        const fallback = classifyWorkflowSteps(mod.workflow);
        expect(fallback.length).toBe(mod.workflow.stepOrder.length);
        return;
      }

      // Every declared stepId must be a REAL execution step so progress wiring
      // (the live stepper) resolves against the run's step records.
      const realStepIds = new Set(Object.keys(mod.workflow.steps));
      for (const group of declared) {
        for (const stepId of group.stepIds) {
          expect(realStepIds.has(stepId)).toBe(true);
        }
      }

      // The classified preview, when handed the declaration, is one entry per
      // display group titled by the declared label, in declared order.
      const classified = classifyWorkflowSteps(mod.workflow, declared);
      expect(classified.map((s) => s.title)).toEqual(
        declared.map((g) => g.label),
      );
      expect(classified.map((s) => s.id)).toEqual(declared.map((g) => g.key));

      // The declaration genuinely regroups the flow: the ungrouped fallback has
      // one entry per execution step, so a grouped workflow must be shorter.
      // (Guards against classify silently ignoring the declaration.)
      const ungrouped = classifyWorkflowSteps(mod.workflow);
      expect(ungrouped.length).toBe(mod.workflow.stepOrder.length);
      expect(classified.length).toBe(declared.length);
    });
  }
});
