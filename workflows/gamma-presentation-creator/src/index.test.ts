import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  DETERMINISTIC_TOOL_KIND,
} from "@workbench/agents";

import { workflow } from "./index";

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: { id: string; input: unknown }[];
} {
  const ran: { id: string; input: unknown }[] = [];
  const invoker: StepInvoker = async ({ agent, input }) => {
    ran.push({ id: agent.id, input });
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

describe("gamma-presentation-creator native workflow", () => {
  test("lists templates, gates on the template form, lists notes, gates on source selection, fetches the note, generates, gates on review, then renders", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-list-notes": {
        notes: [{ id: "note_1", title: "Acme call" }],
        hasMore: false,
      },
      "presentation-source": {
        id: "note_1",
        title: "Acme call",
        summary: "Discovery",
      },
      "presentation-generate": { prompt: "Build a deck", title: "Acme" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("template", { gammaId: "tmpl_1", goal: "Close" });
    await run.signal("source-selection", { noteId: "note_1" });
    await run.signal("review-approval", { approved: true });

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");
    expect(ran.map((r) => r.id)).toEqual([
      "presentation-list-templates",
      "presentation-list-notes",
      "presentation-source",
      "presentation-generate",
      "presentation-render",
    ]);
  });

  test("passes the source-selection signal payload as granola_get_note args", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-source": { id: "note_42", summary: "x" },
      "presentation-generate": { prompt: "p" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("template", { gammaId: "tmpl_1", goal: "Close" });
    await run.signal("source-selection", { noteId: "note_42" });
    await run.signal("review-approval", { approved: true });

    await run.complete;

    const sourceStep = ran.find((r) => r.id === "presentation-source");
    expect(sourceStep?.input).toEqual({ noteId: "note_42" });
  });

  test("feeds the template form and source note into the generate step", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-source": {
        id: "note_1",
        title: "Acme call",
        summary: "Discovery",
      },
      "presentation-generate": { prompt: "p" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("template", {
      gammaId: "tmpl_1",
      audience: "Investors",
      goal: "Close",
    });
    await run.signal("source-selection", { noteId: "note_1" });
    await run.signal("review-approval", { approved: true });

    await run.complete;

    const generateStep = ran.find((r) => r.id === "presentation-generate");
    expect(generateStep?.input).toMatchObject({
      gammaId: "tmpl_1",
      audience: "Investors",
      goal: "Close",
      summary: "Discovery",
    });
  });

  test("feeds the template gammaId and generate prompt into the render tool", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-source": { id: "note_1", summary: "x" },
      "presentation-generate": {
        prompt: "Build a deck about Acme",
        title: "Acme",
      },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("template", { gammaId: "tmpl_99", goal: "Close" });
    await run.signal("source-selection", { noteId: "note_1" });
    await run.signal("review-approval", { approved: true });

    await run.complete;

    const renderStep = ran.find((r) => r.id === "presentation-render");
    expect(renderStep?.input).toMatchObject({
      gammaId: "tmpl_99",
      prompt: "Build a deck about Acme",
    });
  });

  test("render is a deterministic tool step with an argMap, not an inference step", () => {
    const render = workflow.steps.render;
    if (render === undefined || render.kind !== "step") {
      throw new Error("expected a step primitive for render");
    }
    expect(render.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(render.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "gamma_create_from_template",
    );
    expect(render.agent.inference.sources).toEqual([]);
    const argMapTag = render.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMapTag === undefined) throw new Error("expected an argMap tag");
    expect(JSON.parse(argMapTag)).toEqual({
      gammaId: { from: "gammaId" },
      prompt: { from: "reply" },
    });
  });
});
