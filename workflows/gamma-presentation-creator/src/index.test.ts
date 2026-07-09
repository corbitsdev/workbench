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

import { workflow, MAX_ROUNDS } from "./index";

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
  "presentation-generate-1": { reply: "SLIDE 1: v1" },
  "presentation-generate-2": { reply: "SLIDE 1: v2" },
  "presentation-generate-3": { reply: "SLIDE 1: v3" },
  // gamma_create_from_template returns the NEW deck's gammaId (distinct from the
  // template id carried on intake); it must win the persist merge over intake.
  "presentation-render-1": {
    gammaUrl: "https://gamma.app/docs/1",
    gammaId: "deck_1",
  },
  "presentation-render-2": {
    gammaUrl: "https://gamma.app/docs/2",
    gammaId: "deck_2",
  },
  "presentation-render-3": {
    gammaUrl: "https://gamma.app/docs/3",
    gammaId: "deck_3",
  },
  "presentation-describe-1": { reply: "A deck about v1" },
  "presentation-describe-2": { reply: "A deck about v2" },
  "presentation-describe-3": { reply: "A deck about v3" },
};

const intake = {
  artifactId: "art_1",
  deckTitle: "Q3 Deck",
  gammaId: "tmpl_1",
  goal: "Close",
};

describe("artifact → gamma deck workflow", () => {
  test("approve round 1: rounds 2 and 3 are skipped, persists round 1", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", intake);
    await run.signal("preview-1", { approved: true });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toContain("presentation-generate-1");
    expect(ids).toContain("presentation-render-1");
    expect(ids).toContain("presentation-describe-1");
    expect(ids).toContain("presentation-persist-1");
    expect(ids).not.toContain("presentation-generate-2");
    expect(ids).not.toContain("presentation-render-2");
    expect(ids).not.toContain("presentation-describe-2");
    expect(ids).not.toContain("presentation-persist-2");
    expect(ids).not.toContain("presentation-generate-3");
    expect(ids).not.toContain("presentation-describe-3");
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
    await run.signal("preview-1", { approved: true });
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
    await run.signal("preview-1", { approved: true });
    await run.complete;

    const gen1 = ran.find((r) => r.id === "presentation-generate-1");
    expect(gen1?.input).toMatchObject({ text: "raw pasted notes" });
  });

  test("refine round 1, approve round 2: generate-2 runs, round 1 is not persisted, round 3 is skipped", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", intake);
    await run.signal("preview-1", { approved: false, feedback: "shorter" });
    await run.signal("preview-2", { approved: true });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toContain("presentation-generate-2");
    expect(ids).toContain("presentation-persist-2");
    expect(ids).not.toContain("presentation-persist-1");
    expect(ids).not.toContain("presentation-generate-3");

    // The refine round sees the prior draft and the feedback.
    const gen2 = ran.find((r) => r.id === "presentation-generate-2");
    expect(gen2?.input).toMatchObject({
      reply: "SLIDE 1: v1",
      feedback: "shorter",
    });
  });

  test("refine through every round persists the final round", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", intake);
    await run.signal("preview-1", { approved: false, feedback: "a" });
    await run.signal("preview-2", { approved: false, feedback: "b" });
    await run.signal("preview-3", { approved: true });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toContain("presentation-generate-3");
    expect(ids).toContain("presentation-persist-3");
    expect(ids).not.toContain("presentation-persist-1");
    expect(ids).not.toContain("presentation-persist-2");
  });

  test("render maps the template gammaId and the draft reply onto the gamma tool args", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", { ...intake, gammaId: "tmpl_77" });
    await run.signal("preview-1", { approved: true });
    await run.complete;

    const render = ran.find((r) => r.id === "presentation-render-1");
    expect(render?.input).toMatchObject({
      gammaId: "tmpl_77",
      reply: "SLIDE 1: v1",
    });
  });

  test("persist receives the rendered deck url, the description, and the gammaId", async () => {
    const { invoker, ran } = makeRecordingInvoker(baseOutputs);
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", intake);
    await run.signal("preview-1", { approved: true });
    await run.complete;

    const persist = ran.find((r) => r.id === "presentation-persist-1");
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
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const persist = workflow.steps[`persist-${round}`];
      if (persist === undefined || persist.kind !== "step") {
        throw new Error(`expected a step primitive for persist-${round}`);
      }
      const rawArgMap = persist.agent.tags?.[STEP_ARGMAP_TAG];
      if (typeof rawArgMap !== "string") {
        throw new Error(`persist-${round} is missing an argMap tag`);
      }
      expect(JSON.parse(rawArgMap)).toMatchObject({
        pdfUrl: { from: "exportUrl" },
      });
    }
  });

  test("the readers are deterministic, non-fatal, and reshape the intake id", () => {
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
        [arg]: { from: arg },
      });
    }
  });

  test("each round is generate (inline) → render (deterministic gamma) → persist (deterministic artifact)", () => {
    for (let r = 1; r <= MAX_ROUNDS; r += 1) {
      const generate = workflow.steps[`generate-${r}`];
      if (generate === undefined || generate.kind !== "step") {
        throw new Error(`expected a step primitive for generate-${r}`);
      }
      expect(generate.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
      expect(generate.agent.capabilities).toEqual([]);
      expect(generate.agent.systemPrompt.length).toBeGreaterThan(0);

      const render = workflow.steps[`render-${r}`];
      if (render === undefined || render.kind !== "step") {
        throw new Error(`expected a step primitive for render-${r}`);
      }
      expect(render.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(render.agent.tags?.[STEP_TOOL_TAG]).toContain(
        "gamma_create_from_template",
      );
      expect(JSON.parse(render.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
        gammaId: { from: "gammaId" },
        prompt: { from: "reply" },
      });

      const describe = workflow.steps[`describe-${r}`];
      if (describe === undefined || describe.kind !== "step") {
        throw new Error(`expected a step primitive for describe-${r}`);
      }
      expect(describe.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
      expect(describe.agent.systemPrompt.length).toBeGreaterThan(0);

      const persist = workflow.steps[`persist-${r}`];
      if (persist === undefined || persist.kind !== "step") {
        throw new Error(`expected a step primitive for persist-${r}`);
      }
      expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain(
        "artifact_link_gamma_presentation",
      );
      expect(JSON.parse(persist.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual(
        {
          title: { from: "deckTitle" },
          url: { from: "gammaUrl" },
          description: { from: "reply" },
          gammaId: { from: "gammaId" },
          pdfUrl: { from: "exportUrl" },
        },
      );
    }
  });

  test("the preview gate routes approval to persist and refusal to the next round", () => {
    const check = workflow.steps["check-1"];
    if (check === undefined || check.kind !== "gate") {
      throw new Error("expected a gate primitive for check-1");
    }
    expect(check.when).toEqual({ from: "steps.preview-1.output.approved" });
    expect(check.then).toBe("persist-1");
    expect(check.else).toBe("generate-2");
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

  test("the final round has no gate; its preview leads straight to persist", () => {
    expect(workflow.steps[`check-${MAX_ROUNDS}`]).toBeUndefined();
    const persist = workflow.steps[`persist-${MAX_ROUNDS}`];
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a final persist step");
    }
    expect(persist.after).toContain(`preview-${MAX_ROUNDS}`);
  });
});
