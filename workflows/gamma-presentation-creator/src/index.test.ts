import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
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

// Both readers always run; the unused one returns an empty/isError envelope.
const baseOutputs: Record<string, unknown> = {
  "presentation-fetch-artifact": {},
  "presentation-fetch-note": {},
  "presentation-generate": { reply: "SLIDE 1: v1" },
  // gamma_create_from_template returns the NEW deck's gammaId (distinct from the
  // template id carried on intake); it must win the persist merge over intake.
  "presentation-render": {
    gammaUrl: "https://gamma.app/docs/1",
    gammaId: "deck_1",
  },
  "presentation-describe": { reply: "A deck about v1" },
};

const intake = {
  artifactId: "art_1",
  deckTitle: "Q3 Deck",
  gammaId: "tmpl_1",
  goal: "Close",
};

describe("artifact → gamma deck workflow (single-shot)", () => {
  test("intake drives the whole run to persist with no further gate", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", intake);

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toContain("presentation-generate");
    expect(ids).toContain("presentation-render");
    expect(ids).toContain("presentation-describe");
    expect(ids).toContain("presentation-persist");
  });

  test("both readers run and each receives its intake id", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", {
      artifactId: "art_42",
      noteId: "note_7",
      deckTitle: "D",
      gammaId: "t",
      goal: "g",
    });
    await run.complete;

    const artifactRead = ran.find(
      (r) => r.id === "presentation-fetch-artifact",
    );
    const noteRead = ran.find((r) => r.id === "presentation-fetch-note");
    expect(artifactRead?.input).toMatchObject({ artifactId: "art_42" });
    expect(noteRead?.input).toMatchObject({ noteId: "note_7" });
  });

  test("pasted text reaches the generate step", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", {
      text: "raw pasted notes",
      deckTitle: "Paste deck",
      gammaId: "tmpl_1",
      goal: "Inform",
    });
    await run.complete;

    const gen = ran.find((r) => r.id === "presentation-generate");
    expect(gen?.input).toMatchObject({ text: "raw pasted notes" });
  });

  test("render maps the template gammaId and the draft reply onto the gamma tool args", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", { ...intake, gammaId: "tmpl_77" });
    await run.complete;

    const render = ran.find((r) => r.id === "presentation-render");
    expect(render?.input).toMatchObject({
      gammaId: "tmpl_77",
      reply: "SLIDE 1: v1",
    });
  });

  test("persist receives the rendered deck url, the description, and the gammaId", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", intake);
    await run.complete;

    const persist = ran.find((r) => r.id === "presentation-persist");
    // gammaId must be the rendered deck id (render wins the merge), NOT the
    // intake template id (tmpl_1).
    expect(persist?.input).toMatchObject({
      deckTitle: "Q3 Deck",
      gammaId: "deck_1",
      gammaUrl: "https://gamma.app/docs/1",
      reply: "A deck about v1",
    });
  });

  test("persist maps the render step's exportUrl to the pdfUrl arg", () => {
    const persist = workflow.steps["persist"];
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    const rawArgMap = persist.agent.tags?.[STEP_ARGMAP_TAG];
    if (typeof rawArgMap !== "string") {
      throw new Error("persist is missing an argMap tag");
    }
    expect(JSON.parse(rawArgMap)).toMatchObject({
      pdfUrl: { fromJson: "content", field: "exportUrl" },
    });
  });

  test("the readers are deterministic, non-fatal, and reshape the intake id as optional", () => {
    for (const [key, tool, arg] of [
      ["fetch-artifact", "artifact_read", "artifactId"],
      ["fetch-note", "granola_get_note", "noteId"],
    ] as const) {
      const reader = workflow.steps[key];
      if (reader === undefined || reader.kind !== "step") {
        throw new Error(`expected a step primitive for ${key}`);
      }
      expect(reader.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(reader.agent.tags?.[STEP_TOOL_TAG]).toContain(tool);
      expect(reader.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
      expect(JSON.parse(reader.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
        [arg]: { from: arg, optional: true },
      });
    }
  });

  test("generate (inline) → render (deterministic gamma) → persist (deterministic artifact)", () => {
    const generate = workflow.steps["generate"];
    if (generate === undefined || generate.kind !== "step") {
      throw new Error("expected a step primitive for generate");
    }
    expect(generate.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(generate.agent.capabilities).toEqual([]);
    expect(generate.agent.systemPrompt.length).toBeGreaterThan(0);

    const render = workflow.steps["render"];
    if (render === undefined || render.kind !== "step") {
      throw new Error("expected a step primitive for render");
    }
    expect(render.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(render.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "gamma_create_from_template",
    );
    expect(JSON.parse(render.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
      gammaId: { from: "gammaId" },
      prompt: { from: "reply" },
    });

    const describe = workflow.steps["describe"];
    if (describe === undefined || describe.kind !== "step") {
      throw new Error("expected a step primitive for describe");
    }
    expect(describe.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(describe.agent.systemPrompt.length).toBeGreaterThan(0);

    const persist = workflow.steps["persist"];
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "artifact_link_gamma_presentation",
    );
    expect(JSON.parse(persist.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
      title: { from: "deckTitle" },
      description: { from: "reply" },
      url: { fromJson: "content", field: "gammaUrl" },
      gammaId: { fromJson: "content", field: "gammaId" },
      pdfUrl: { fromJson: "content", field: "exportUrl" },
    });
  });

  test("there is no preview or check gate; persist depends directly on render and describe", () => {
    expect(workflow.steps["preview-1"]).toBeUndefined();
    expect(workflow.steps["check-1"]).toBeUndefined();
    const persist = workflow.steps["persist"];
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.after).toEqual(["render", "describe"]);
  });

  test("there is no list-templates step; the hub serves templates to the intake UI", () => {
    expect(workflow.steps["list-templates"]).toBeUndefined();
    const ids = Object.values(workflow.steps).flatMap((step) =>
      step.kind === "step" ? [step.agent.tags?.[STEP_TOOL_TAG]] : [],
    );
    expect(ids).not.toContain("gamma_list_templates");
  });

  test("the source readers preload each tool's max for client-side paging", () => {
    // Each limit is the tool's own ceiling — a higher literal is silently
    // truncated. artifact_list allows 50; granola_list_notes clamps to 30.
    for (const [key, limit] of [
      ["list-artifacts", 50],
      ["list-notes", 30],
    ] as const) {
      const step = workflow.steps[key];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a deterministic tool step for ${key}`);
      }
      expect(JSON.parse(step.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
        limit: { literal: limit },
      });
    }
  });

  test("intake waits only on the two readers, not on list-templates", () => {
    const intakeStep = workflow.steps["intake"];
    if (intakeStep === undefined || intakeStep.kind !== "awaitSignal") {
      throw new Error("expected an awaitSignal primitive for intake");
    }
    expect(intakeStep.after).toEqual(["list-artifacts", "list-notes"]);
    expect(intakeStep.after).not.toContain("list-templates");
  });
});
