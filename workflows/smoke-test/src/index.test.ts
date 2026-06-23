import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";

import { workflow } from "./index";

describe("smoke-test native workflow", () => {
  test("dispatches the single emit step to completion on the manual trigger, no signal gate", async () => {
    const ran: string[] = [];
    const invoker: StepInvoker = async ({ agent }) => {
      ran.push(agent.id);
      return { output: { reply: "SMOKE_TEST_OK" } };
    };

    const run = runLocal(workflow, { invokeStep: invoker });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");
    // The whole point of the diagnostic: one inference step runs immediately on
    // the trigger, with nothing to wait on.
    expect(ran).toEqual(["smoke-test-emit"]);
  });

  test("emit is a genuine inference step (one source), not a deterministic tool step", () => {
    const emit = workflow.steps.emit;
    if (emit === undefined || emit.kind !== "step") {
      throw new Error("expected a step primitive for emit");
    }
    // An inference step carries an inference source and no deterministic-tool
    // marker tag; that is what makes it dispatch a reasoning turn rather than a
    // direct tool call.
    expect(emit.agent.inference.sources.length).toBe(1);
    expect(emit.agent.tags?.["workbench.stepKind"]).toBeUndefined();
    expect(emit.after ?? []).toEqual([]);
  });
});
