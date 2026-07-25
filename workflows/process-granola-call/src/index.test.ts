/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import { LLM_WRITER_MODEL } from "@workbench/agents";
import {
  GRANOLA_GET_NOTE_HANDLER,
  PREPARE_DOCUMENT_HANDLER,
  WRITE_ARTIFACT_HANDLER,
  workflow,
  kind,
  label,
  description,
  INTAKE_FIELDS,
} from "./index";
import { DISPLAY_STEPS } from "./display-steps";

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("process-granola-call workflow", () => {
  test("exports kind/label/description and requires exactly noteId at intake", () => {
    expect(kind).toBe("process-granola-call");
    expect(label).toBe("Process Granola Call");
    expect(description.length).toBeGreaterThan(20);
    expect(INTAKE_FIELDS).toHaveLength(1);
    expect(INTAKE_FIELDS[0].name).toBe("noteId");
    expect(INTAKE_FIELDS[0].required).toBe(true);
  });

  test("step graph: fetch feeds transcript/extract prep; extract feeds processed prep/finalize; persist closes", () => {
    expect(Object.keys(workflow.steps).sort()).toEqual([
      "extract",
      "fetch",
      "finalize",
      "persist",
      "prepare-persist",
      "prepare-processed",
      "prepare-transcript",
      "processed",
      "transcript",
    ]);
    expect(actionPrimitive("fetch").after).toBeUndefined();
    expect(actionPrimitive("prepare-transcript").after).toEqual(["fetch"]);
    expect(actionPrimitive("transcript").after).toEqual(["prepare-transcript"]);
    expect(stepPrimitive("extract").after).toEqual(["fetch"]);
    expect(actionPrimitive("prepare-processed").after).toEqual([
      "fetch",
      "extract",
    ]);
    expect(actionPrimitive("processed").after).toEqual([
      "prepare-processed",
      "transcript",
    ]);
    expect(stepPrimitive("finalize").after).toEqual(["extract"]);
    expect(actionPrimitive("prepare-persist").after).toEqual([
      "fetch",
      "finalize",
    ]);
    expect(actionPrimitive("persist").after).toEqual([
      "prepare-persist",
      "processed",
    ]);
  });

  test("fetch is a native action passing trigger.payload's noteId to granola_get_note verbatim", () => {
    const fetch = actionPrimitive("fetch");
    expect(fetch.handler).toBe(GRANOLA_GET_NOTE_HANDLER);
    expect(GRANOLA_GET_NOTE_HANDLER).toBe(
      "@workbench/tools-granola/granola:granola_get_note",
    );
    expect(fetch.input).toEqual({ from: "trigger.payload" });
    expect(fetch.effect).toEqual({ requires: [GRANOLA_GET_NOTE_HANDLER] });
  });

  test("prepare-* actions shape write_artifact's title/body/sourceRefKey via the workflow-owned tool", () => {
    expect(PREPARE_DOCUMENT_HANDLER).toBe(
      "@workbench/tools-process-granola-call/core:process_granola_prepare_document",
    );

    const prepareTranscript = actionPrimitive("prepare-transcript");
    expect(prepareTranscript.handler).toBe(PREPARE_DOCUMENT_HANDLER);
    expect(prepareTranscript.input).toEqual({
      merge: [{ from: "steps.fetch.output" }, { from: "trigger.payload" }],
    });

    const prepareProcessed = actionPrimitive("prepare-processed");
    expect(prepareProcessed.input).toEqual({
      merge: [
        { from: "steps.fetch.output" },
        { from: "steps.extract.output" },
        { from: "trigger.payload" },
        { literal: { includeParent: true } },
      ],
    });

    const preparePersist = actionPrimitive("prepare-persist");
    expect(preparePersist.input).toEqual({
      merge: [
        { from: "steps.fetch.output" },
        { from: "steps.finalize.output" },
        { from: "trigger.payload" },
        { literal: { includeParent: true } },
      ],
    });
  });

  // The artifact chain is keyed per note via server-side sourceRef
  // composition (write_artifact's sourceRefPrefix + sourceRefKey, the latter
  // shaped by prepare-* into noteId). Each artifact must use a DISTINCT
  // prefix and the same per-note key, so re-runs upsert all three in place
  // without cross-artifact collisions.
  test("write_artifact actions merge the shaped document with distinct sourceRef prefixes", () => {
    const transcript = actionPrimitive("transcript");
    expect(transcript.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(transcript.input).toEqual({
      merge: [
        { from: "steps.prepare-transcript.output.content" },
        {
          literal: {
            titlePrefix: "Transcript — ",
            kind: "research",
            sourceRefPrefix: "granola-transcript",
            jobLabel: label,
          },
        },
      ],
    });

    const processed = actionPrimitive("processed");
    expect(processed.input).toEqual({
      merge: [
        { from: "steps.prepare-processed.output.content" },
        {
          literal: {
            titlePrefix: "Working notes — ",
            kind: "research",
            sourceRefPrefix: "granola-processed",
            parentSourceRefPrefix: "granola-transcript",
            jobLabel: label,
          },
        },
      ],
    });

    const persist = actionPrimitive("persist");
    expect(persist.input).toEqual({
      merge: [
        { from: "steps.prepare-persist.output.content" },
        {
          literal: {
            kind: "research",
            sourceRefPrefix: "granola-call-note",
            parentSourceRefPrefix: "granola-processed",
            jobLabel: label,
          },
        },
      ],
    });

    const prefixes = [transcript, processed, persist].map((primitive) => {
      const merge = (
        primitive.input as { merge: { literal: Record<string, unknown> }[] }
      ).merge;
      const literalEntry = merge[1];
      if (literalEntry === undefined) {
        throw new Error("expected a literal merge entry at index 1");
      }
      return literalEntry.literal.sourceRefPrefix;
    });
    expect(new Set(prefixes).size).toBe(3);
  });

  test("model cascade: extract on the deploy default, finalize pinned to the writer model with a real token ceiling", () => {
    const extract = stepPrimitive("extract");
    const finalize = stepPrimitive("finalize");
    expect(extract.agent.inference).toEqual({ sources: [] });
    expect(finalize.agent.inference.sources.map((s) => s.model)).toEqual([
      LLM_WRITER_MODEL,
    ]);
    // Truncated call notes shipped to production when this was absent — the
    // source's default output ceiling cut documents off mid-sentence.
    expect(finalize.agent.inference.sources[0]?.parameters?.maxTokens).toBe(
      16384,
    );
  });

  test("display steps cover the flow, including the shaping actions", () => {
    expect(DISPLAY_STEPS.map((s) => s.key)).toEqual([
      "fetch",
      "transcript",
      "extract",
      "finalize",
    ]);
    const displayed = new Set(DISPLAY_STEPS.flatMap((s) => s.stepIds));
    for (const stepId of Object.keys(workflow.steps)) {
      expect(displayed.has(stepId)).toBe(true);
    }
  });

  test("end to end: fetch, shape, and persist each stage's artifact via native actions", async () => {
    const note = JSON.stringify({ title: "Sync with Acme", transcript: "…" });
    const invokerCalls: { id: string; input: unknown }[] = [];
    const invoker: StepInvoker = async ({ agent, input }) => {
      invokerCalls.push({ id: agent.id, input });
      if (agent.id === "process-granola-extract") {
        return { output: { reply: "Working notes body" } };
      }
      if (agent.id === "process-granola-finalize") {
        return { output: { reply: "Final call notes body" } };
      }
      throw new Error(`unexpected agent step ${agent.id}`);
    };

    const actionCalls: { ref: string; input: unknown }[] = [];
    const actionOutputs: Record<string, unknown> = {
      [GRANOLA_GET_NOTE_HANDLER]: { content: note },
      [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1" },
    };
    const actionResolver = (ref: string): ActionHandler => {
      return async (input): Promise<unknown> => {
        actionCalls.push({ ref, input });
        if (ref === PREPARE_DOCUMENT_HANDLER) {
          const args = input as {
            content: string;
            reply?: string;
            noteId: string;
            includeParent?: boolean;
          };
          const { title } = JSON.parse(args.content) as { title: string };
          const body = args.reply ?? args.content;
          return {
            content: {
              title,
              body,
              sourceRefKey: args.noteId,
              ...(args.includeParent
                ? { parentSourceRefKey: args.noteId }
                : {}),
            },
          };
        }
        return actionOutputs[ref] ?? null;
      };
    };

    const result = await runLocal(workflow, {
      invokeStep: invoker,
      actionResolver,
      triggerPayload: { noteId: "note_123" },
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    expect(invokerCalls.map((c) => c.id).sort()).toEqual([
      "process-granola-extract",
      "process-granola-finalize",
    ]);
    const refCounts = actionCalls.reduce<Record<string, number>>(
      (acc, call) => {
        acc[call.ref] = (acc[call.ref] ?? 0) + 1;
        return acc;
      },
      {},
    );
    expect(refCounts).toEqual({
      [GRANOLA_GET_NOTE_HANDLER]: 1,
      [PREPARE_DOCUMENT_HANDLER]: 3,
      [WRITE_ARTIFACT_HANDLER]: 3,
    });
    // fetch must precede every prepare-* call, and each prepare-* must
    // precede its own write_artifact call — this is where the DAG's real
    // ordering guarantee (not just step count) is worth asserting.
    const fetchIndex = actionCalls.findIndex(
      (c) => c.ref === GRANOLA_GET_NOTE_HANDLER,
    );
    const prepareIndices = actionCalls
      .map((c, i) => (c.ref === PREPARE_DOCUMENT_HANDLER ? i : -1))
      .filter((i) => i >= 0);
    const writeIndices = actionCalls
      .map((c, i) => (c.ref === WRITE_ARTIFACT_HANDLER ? i : -1))
      .filter((i) => i >= 0);
    for (const i of prepareIndices) {
      expect(i).toBeGreaterThan(fetchIndex);
    }
    expect(Math.min(...writeIndices)).toBeGreaterThan(
      Math.min(...prepareIndices),
    );
  });
});
