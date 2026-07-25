import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
} from "@workbench/agents";

import {
  ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER,
  ARTIFACT_LIST_HANDLER,
  GAMMA_CREATE_FROM_TEMPLATE_HANDLER,
  GRANOLA_LIST_NOTES_HANDLER,
  PREPARE_PERSIST_HANDLER,
  PREPARE_RENDER_HANDLER,
  workflow,
} from "./index";

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

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

function makeActionResolver(
  outputs: Record<string, unknown>,
  calls: Record<string, unknown>[],
): (ref: string) => ActionHandler {
  return (ref: string): ActionHandler => {
    return async (input): Promise<unknown> => {
      calls.push({ ref, input });
      return outputs[ref] ?? null;
    };
  };
}

describe("gamma-presentation-creator native action wiring", () => {
  test("list-artifacts is a native action preloading artifact_list's max page", () => {
    const listArtifacts = actionPrimitive("list-artifacts");
    expect(listArtifacts.handler).toBe(ARTIFACT_LIST_HANDLER);
    expect(listArtifacts.input).toEqual({ literal: { limit: 50 } });
    expect(listArtifacts.effect).toEqual({
      requires: [ARTIFACT_LIST_HANDLER],
    });
  });

  test("list-notes is a native action preloading granola_list_notes' max page", () => {
    const listNotes = actionPrimitive("list-notes");
    expect(listNotes.handler).toBe(GRANOLA_LIST_NOTES_HANDLER);
    expect(listNotes.input).toEqual({ literal: { limit: 30 } });
    expect(listNotes.effect).toEqual({
      requires: [GRANOLA_LIST_NOTES_HANDLER],
    });
  });

  test("prepare-render is a native action renaming generate's reply to gamma_create_from_template's prompt arg", () => {
    const prepareRender = actionPrimitive("prepare-render");
    expect(prepareRender.handler).toBe(PREPARE_RENDER_HANDLER);
    expect(prepareRender.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.generate.output" },
      ],
    });
    expect(prepareRender.effect).toEqual({
      requires: [PREPARE_RENDER_HANDLER],
    });
    expect(prepareRender.after).toEqual(["generate"]);
  });

  test("render is a native action passthrough dispatching gamma_create_from_template on prepare-render's output", () => {
    const render = actionPrimitive("render");
    expect(render.handler).toBe(GAMMA_CREATE_FROM_TEMPLATE_HANDLER);
    expect(render.input).toEqual({
      from: "steps.prepare-render.output.content",
    });
    expect(render.effect).toEqual({
      requires: [GAMMA_CREATE_FROM_TEMPLATE_HANDLER],
    });
    expect(render.after).toEqual(["prepare-render"]);
  });

  test("prepare-persist is a native action pairing intake/render/describe fields into artifact_link_gamma_presentation's arg names", () => {
    const preparePersist = actionPrimitive("prepare-persist");
    expect(preparePersist.handler).toBe(PREPARE_PERSIST_HANDLER);
    expect(preparePersist.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.render.output.content" },
        { from: "steps.describe.output" },
      ],
    });
    expect(preparePersist.effect).toEqual({
      requires: [PREPARE_PERSIST_HANDLER],
    });
    expect(preparePersist.after).toEqual(["render", "describe"]);
  });

  test("persist is a native action passthrough dispatching artifact_link_gamma_presentation on prepare-persist's output", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER);
    expect(persist.input).toEqual({
      from: "steps.prepare-persist.output.content",
    });
    expect(persist.effect).toEqual({
      requires: [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER],
    });
    expect(persist.after).toEqual(["prepare-persist"]);
  });
});

describe("artifact → gamma deck workflow (single-shot)", () => {
  test("intake drives the whole run to persist with no further gate", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-fetch-artifact": {},
      "presentation-fetch-note": {},
      "presentation-generate": { reply: "SLIDE 1: v1" },
      "presentation-describe": { reply: "A deck about v1" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
        [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
        [PREPARE_RENDER_HANDLER]: {
          content: { gammaId: "tmpl_1", prompt: "SLIDE 1: v1" },
        },
        [GAMMA_CREATE_FROM_TEMPLATE_HANDLER]: {
          content: {
            gammaUrl: "https://gamma.app/docs/1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            exportUrl: "",
          },
        },
        [PREPARE_PERSIST_HANDLER]: {
          content: {
            title: "Q3 Deck",
            description: "A deck about v1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            pdfUrl: "",
          },
        },
        [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER]: { artifactId: "art_new" },
      },
      actionCalls,
    );
    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });

    await run.signal("intake", {
      artifactId: "art_1",
      deckTitle: "Q3 Deck",
      gammaId: "tmpl_1",
      goal: "Close",
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toContain("presentation-generate");
    expect(ids).toContain("presentation-describe");

    const refs = actionCalls.map((c) => c.ref);
    expect(refs).toEqual([
      ARTIFACT_LIST_HANDLER,
      GRANOLA_LIST_NOTES_HANDLER,
      PREPARE_RENDER_HANDLER,
      GAMMA_CREATE_FROM_TEMPLATE_HANDLER,
      PREPARE_PERSIST_HANDLER,
      ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER,
    ]);
  });

  test("both readers run and each receives its intake id", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-fetch-artifact": {},
      "presentation-fetch-note": {},
      "presentation-generate": { reply: "SLIDE 1: v1" },
      "presentation-describe": { reply: "A deck about v1" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
        [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
        [PREPARE_RENDER_HANDLER]: {
          content: { gammaId: "t", prompt: "SLIDE 1: v1" },
        },
        [GAMMA_CREATE_FROM_TEMPLATE_HANDLER]: {
          content: {
            gammaUrl: "https://gamma.app/docs/1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            exportUrl: "",
          },
        },
        [PREPARE_PERSIST_HANDLER]: {
          content: {
            title: "D",
            description: "A deck about v1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            pdfUrl: "",
          },
        },
        [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER]: { artifactId: "art_new" },
      },
      actionCalls,
    );
    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });

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
    const { invoker, ran } = makeRecordingInvoker({
      "presentation-fetch-artifact": {},
      "presentation-fetch-note": {},
      "presentation-generate": { reply: "SLIDE 1: v1" },
      "presentation-describe": { reply: "A deck about v1" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
        [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
        [PREPARE_RENDER_HANDLER]: {
          content: { gammaId: "tmpl_1", prompt: "SLIDE 1: v1" },
        },
        [GAMMA_CREATE_FROM_TEMPLATE_HANDLER]: {
          content: {
            gammaUrl: "https://gamma.app/docs/1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            exportUrl: "",
          },
        },
        [PREPARE_PERSIST_HANDLER]: {
          content: {
            title: "Paste deck",
            description: "A deck about v1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            pdfUrl: "",
          },
        },
        [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER]: { artifactId: "art_new" },
      },
      actionCalls,
    );
    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });

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

  test("prepare-render receives the template gammaId and the draft reply", async () => {
    const { invoker } = makeRecordingInvoker({
      "presentation-fetch-artifact": {},
      "presentation-fetch-note": {},
      "presentation-generate": { reply: "SLIDE 1: v1" },
      "presentation-describe": { reply: "A deck about v1" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
        [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
        [PREPARE_RENDER_HANDLER]: {
          content: { gammaId: "tmpl_77", prompt: "SLIDE 1: v1" },
        },
        [GAMMA_CREATE_FROM_TEMPLATE_HANDLER]: {
          content: {
            gammaUrl: "https://gamma.app/docs/1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            exportUrl: "",
          },
        },
        [PREPARE_PERSIST_HANDLER]: {
          content: {
            title: "Q3 Deck",
            description: "A deck about v1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            pdfUrl: "",
          },
        },
        [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER]: { artifactId: "art_new" },
      },
      actionCalls,
    );
    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });
    await run.signal("intake", {
      artifactId: "art_1",
      deckTitle: "Q3 Deck",
      gammaId: "tmpl_77",
      goal: "Close",
    });
    await run.complete;

    const prepareRenderCall = actionCalls.find(
      (c) => c.ref === PREPARE_RENDER_HANDLER,
    );
    expect(prepareRenderCall?.input).toMatchObject({
      gammaId: "tmpl_77",
      reply: "SLIDE 1: v1",
    });
  });

  test("prepare-persist receives the rendered deck url, the description, and the NEW gammaId (not the template id)", async () => {
    const { invoker } = makeRecordingInvoker({
      "presentation-fetch-artifact": {},
      "presentation-fetch-note": {},
      "presentation-generate": { reply: "SLIDE 1: v1" },
      "presentation-describe": { reply: "A deck about v1" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
        [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
        [PREPARE_RENDER_HANDLER]: {
          content: { gammaId: "tmpl_1", prompt: "SLIDE 1: v1" },
        },
        [GAMMA_CREATE_FROM_TEMPLATE_HANDLER]: {
          content: {
            gammaUrl: "https://gamma.app/docs/1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            exportUrl: "",
          },
        },
        [PREPARE_PERSIST_HANDLER]: {
          content: {
            title: "Q3 Deck",
            description: "A deck about v1",
            url: "https://gamma.app/docs/1",
            gammaId: "deck_1",
            pdfUrl: "",
          },
        },
        [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER]: { artifactId: "art_new" },
      },
      actionCalls,
    );
    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });
    await run.signal("intake", {
      artifactId: "art_1",
      deckTitle: "Q3 Deck",
      gammaId: "tmpl_1",
      goal: "Close",
    });
    await run.complete;

    const preparePersistCall = actionCalls.find(
      (c) => c.ref === PREPARE_PERSIST_HANDLER,
    );
    // gammaId must be the rendered deck id (render's content wins the merge),
    // NOT the intake template id (tmpl_1).
    expect(preparePersistCall?.input).toMatchObject({
      deckTitle: "Q3 Deck",
      gammaId: "deck_1",
      url: "https://gamma.app/docs/1",
      reply: "A deck about v1",
    });
  });

  test("the readers are deterministic, non-fatal, and skip the whole step when the intake id is absent", () => {
    // artifactId/noteId are each the sole argMap field and the underlying
    // tool's only required argument, so there is no sensible "call without
    // it" — these use skipStepIfAbsent, not optional (which would omit the
    // argument and call the tool anyway). This gap is genuine: native
    // `action` has no error-swallow / conditional-skip equivalent, so these
    // two steps stay on `deterministicToolStep` (CL-4454).
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
        [arg]: { from: arg, skipStepIfAbsent: true },
      });
    }
  });

  test("generate/describe stay inline agent steps; list/render/persist are native actions", () => {
    const generate = workflow.steps["generate"];
    if (generate === undefined || generate.kind !== "step") {
      throw new Error("expected a step primitive for generate");
    }
    expect(generate.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(generate.agent.capabilities).toEqual([]);
    expect(generate.agent.systemPrompt.length).toBeGreaterThan(0);

    const describe = workflow.steps["describe"];
    if (describe === undefined || describe.kind !== "step") {
      throw new Error("expected a step primitive for describe");
    }
    expect(describe.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(describe.agent.systemPrompt.length).toBeGreaterThan(0);

    for (const id of [
      "list-artifacts",
      "list-notes",
      "prepare-render",
      "render",
      "prepare-persist",
      "persist",
    ]) {
      expect(workflow.steps[id]?.kind).toBe("action");
    }
  });

  test("there is no preview or check gate; persist depends on prepare-persist, which depends on render and describe", () => {
    expect(workflow.steps["preview-1"]).toBeUndefined();
    expect(workflow.steps["check-1"]).toBeUndefined();
    const persist = actionPrimitive("persist");
    expect(persist.after).toEqual(["prepare-persist"]);
    const preparePersist = actionPrimitive("prepare-persist");
    expect(preparePersist.after).toEqual(["render", "describe"]);
  });

  test("there is no list-templates step; the hub serves templates to the intake UI", () => {
    expect(workflow.steps["list-templates"]).toBeUndefined();
    const refs = Object.values(workflow.steps).flatMap((step) =>
      step.kind === "action" ? [step.handler] : [],
    );
    expect(refs).not.toContain("gamma_list_templates");
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
