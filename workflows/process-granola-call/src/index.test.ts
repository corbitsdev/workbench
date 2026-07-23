import { describe, expect, test } from "bun:test";
import { LLM_WRITER_MODEL } from "@workbench/agents";
import { workflow, kind, label, description, INTAKE_FIELDS } from "./index";
import { DISPLAY_STEPS } from "./display-steps";

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function argMapOf(stepId: string): Record<string, unknown> {
  const tag = stepPrimitive(stepId).agent.tags?.["workbench.argMap"];
  if (typeof tag !== "string") {
    throw new Error(`step "${stepId}" has no argMap tag`);
  }
  return JSON.parse(tag) as Record<string, unknown>;
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

  test("step graph: fetch feeds transcript/extract; extract feeds processed/finalize; persist closes", () => {
    expect(Object.keys(workflow.steps).sort()).toEqual([
      "extract",
      "fetch",
      "finalize",
      "persist",
      "processed",
      "transcript",
    ]);
    expect(stepPrimitive("transcript").after).toEqual(["fetch"]);
    expect(stepPrimitive("extract").after).toEqual(["fetch"]);
    expect(stepPrimitive("processed").after).toEqual(["extract"]);
    expect(stepPrimitive("finalize").after).toEqual(["extract"]);
    expect(stepPrimitive("persist").after).toEqual(["finalize"]);
  });

  test("fetch maps the intake noteId to granola_get_note", () => {
    expect(stepPrimitive("fetch").agent.tags?.["workbench.tool"]).toBe(
      "@workbench/tools-granola/granola:granola_get_note",
    );
    expect(argMapOf("fetch").noteId).toEqual({ from: "noteId" });
  });

  // The artifact chain is keyed per note via server-side sourceRef
  // composition (write_artifact's sourceRefPrefix + sourceRefKey) because
  // argMaps cannot concatenate strings. Each artifact must use a DISTINCT
  // prefix and the same per-note key, so re-runs upsert all three in place
  // without cross-artifact collisions.
  test("artifact chain: distinct sourceRef prefixes, all keyed by noteId", () => {
    const prefixes = ["transcript", "processed", "persist"].map((stepId) => {
      const argMap = argMapOf(stepId);
      expect(argMap.sourceRefKey).toEqual({ from: "noteId" });
      const prefix = argMap.sourceRefPrefix as { literal: string };
      return prefix.literal;
    });
    expect(prefixes).toEqual([
      "granola-transcript",
      "granola-processed",
      "granola-call-note",
    ]);
    expect(new Set(prefixes).size).toBe(3);
  });

  test("reasoning outputs reach artifact bodies through the invoker's real field (reply)", () => {
    expect(argMapOf("processed").body).toEqual({ from: "reply" });
    expect(argMapOf("persist").body).toEqual({ from: "reply" });
    // The raw transcript artifact carries the fetch ToolResult's content
    // (the note JSON string) verbatim.
    expect(argMapOf("transcript").body).toEqual({ from: "content" });
  });

  test("model cascade: extract on the deploy default, finalize pinned to the writer model", () => {
    const extract = stepPrimitive("extract");
    const finalize = stepPrimitive("finalize");
    expect(extract.agent.inference).toEqual({ sources: [] });
    expect(
      finalize.agent.inference.sources.map((s) => s.model),
    ).toEqual([LLM_WRITER_MODEL]);
  });

  test("display steps cover the flow", () => {
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
});
