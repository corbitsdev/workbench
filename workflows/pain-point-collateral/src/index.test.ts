import { describe, expect, test } from "bun:test";
import { defineAgent } from "@intx/agent";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import type { ActionHandler } from "@intx/workflow";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";

import {
  workflow,
  GRANOLA_GET_NOTE_HANDLER,
  GRANOLA_LIST_NOTES_HANDLER,
  PERSIST_PIECES_HANDLER,
} from "./index";

// The retired `deterministic-tool` authoring kind's tags. Kept as literals
// (not an import from `@workbench/agents`, which no longer exports them) —
// this test only asserts the tags are ABSENT from every native step, proving
// no step regresses onto the deleted mechanism.
const STEP_KIND_TAG = "workbench.stepKind";
const STEP_TOOL_TAG = "workbench.tool";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/**
 * Records each action dispatch by its handler ref and returns a canned
 * output, mirroring `makeRecordingInvoker` for the `step` primitive but for
 * native `action` primitives (no agent, no step-tool tags — dispatched via
 * `runLocal`'s `actionResolver`, not `invokeStep`).
 */
function makeRecordingActionResolver(outputs: Record<string, unknown> = {}): {
  resolver: (ref: string) => ActionHandler;
  ran: { handler: string; input: unknown }[];
} {
  const ran: { handler: string; input: unknown }[] = [];
  const resolver = (ref: string): ActionHandler => {
    return async (input) => {
      ran.push({ handler: ref, input });
      return outputs[ref] ?? null;
    };
  };
  return { resolver, ran };
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

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function mapPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "map") {
    throw new Error(
      `expected map primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

describe("pain-point-collateral native workflow", () => {
  // -------------------------------------------------------------------------
  // Full happy-path run
  // -------------------------------------------------------------------------
  test("executes full 8-step flow: intake → select → fetch → context → analyze → ppSelection → fmtSelection → generate → review → persist", async () => {
    const analyzeReply = JSON.stringify({
      painPoints: [
        { id: "pp1", title: "Slow onboarding", detail: "Takes weeks." },
        { id: "pp2", title: "No ROI visibility", detail: "No clear metric." },
      ],
    });
    const generateReply = JSON.stringify({
      format: "Email",
      title: "Email",
      content: "Hi...",
    });

    const { invoker, ran } = makeRecordingInvoker({
      "pain-point-collateral-analyze": AGENT_REPLY(analyzeReply),
      "pain-point-collateral-generate": AGENT_REPLY(generateReply),
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [GRANOLA_LIST_NOTES_HANDLER]: {
        notes: [{ id: "note_1", title: "Acme call" }],
      },
      [GRANOLA_GET_NOTE_HANDLER]: {
        id: "note_1",
        title: "Acme call",
        summary: "Discovery",
      },
      [PERSIST_PIECES_HANDLER]: { results: [{ artifactId: "art_1" }] },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("note-selection", { noteId: "note_1" });
    await run.signal("context", { context: "Focus on onboarding" });
    await run.signal("pain-point-selection", { selectedIds: ["pp1"] });
    await run.signal("format-selection", {
      items: [
        {
          format: "Email",
          painPointId: "pp1",
          painPointTitle: "Test pain point",
          painPointDetail: "Detail here",
          severity: "high",
        },
      ],
    });
    await run.signal("review", {
      decisions: [
        { format: "Email", title: "Email", content: "Hi...", approved: true },
      ],
      approvedPieces: [{ format: "Email", title: "Email", content: "Hi..." }],
    });

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    // Deterministic actions + inference steps (generate runs once per format item)
    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).toContain(GRANOLA_LIST_NOTES_HANDLER);
    expect(actionRefs).toContain(GRANOLA_GET_NOTE_HANDLER);
    expect(actionRefs).toContain(PERSIST_PIECES_HANDLER);
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("pain-point-collateral-analyze");
    expect(ranIds).toContain("pain-point-collateral-generate");
  });

  // -------------------------------------------------------------------------
  // Native action structure
  // -------------------------------------------------------------------------
  test("intake and fetch are native action primitives — no Workbench dispatch tags, no agent", () => {
    const intake = actionPrimitive("intake");
    const fetch = actionPrimitive("fetch");

    expect(intake.handler).toBe(GRANOLA_LIST_NOTES_HANDLER);
    expect(intake.input).toEqual({ literal: {} });
    expect(intake.effect).toEqual({ requires: [GRANOLA_LIST_NOTES_HANDLER] });

    expect(fetch.handler).toBe(GRANOLA_GET_NOTE_HANDLER);
    expect(fetch.input).toEqual({ from: "steps.select.output" });
    expect(fetch.effect).toEqual({ requires: [GRANOLA_GET_NOTE_HANDLER] });

    // No `agent` field at all on an action primitive — confirms there is
    // nothing left for a Workbench-specific step-kind/argMap tag to hang off.
    expect("agent" in intake).toBe(false);
    expect("agent" in fetch).toBe(false);
  });

  test("analyze is a native reasoning step (agentStep) with a real prompt and no dispatch tag", () => {
    const analyze = stepPrimitive("analyze");
    // No Workbench dispatch tag at all: no deterministic tool tag, real
    // reasoning prompt, and no source declared on the definition (the source
    // is pinned at deploy time / resolved by the sidecar).
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(analyze.agent.capabilities).toEqual([]);
    expect(analyze.agent.inference.sources).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Selector wiring
  // -------------------------------------------------------------------------
  test("fetch action input reads from the note-selection signal output", () => {
    expect(actionPrimitive("fetch").input).toEqual({
      from: "steps.select.output",
    });
  });

  test("analyze step input merges fetch output and context signal output", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.input).toEqual({
      merge: [{ from: "steps.fetch.output" }, { from: "steps.context.output" }],
    });
  });

  test("generate map iterates over fmtSelection.output.items", () => {
    const gen = mapPrimitive("generate");
    expect(gen.over).toEqual({ from: "steps.fmtSelection.output.items" });
  });

  test("generate inner step reads input from trigger.payload only", () => {
    const gen = mapPrimitive("generate");
    expect(gen.step.input).toEqual({ from: "trigger.payload" });
  });

  test("persist is a native action dispatching the batch persist-pieces handler over review.output", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(PERSIST_PIECES_HANDLER);
    expect(persist.input).toEqual({ from: "steps.review.output" });
    expect(persist.effect).toEqual({ requires: [PERSIST_PIECES_HANDLER] });
  });

  // -------------------------------------------------------------------------
  // Signal ordering — workflow blocks until each awaitSignal
  // -------------------------------------------------------------------------
  test("workflow is blocked at context signal after fetch completes", async () => {
    const { invoker, ran } = makeRecordingInvoker({});
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [GRANOLA_LIST_NOTES_HANDLER]: { notes: [] },
      [GRANOLA_GET_NOTE_HANDLER]: { id: "note_1", title: "x", summary: "" },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("note-selection", { noteId: "note_1" });

    // Poll for fetch to complete
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (actionsRan.some((r) => r.handler === GRANOLA_GET_NOTE_HANDLER)) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // Analyze should NOT have run yet — blocked on context signal
    expect(ran.some((r) => r.id === "pain-point-collateral-analyze")).toBe(
      false,
    );

    // Send context — workflow continues
    await run.signal("context", { context: "" });
    await run.signal("pain-point-selection", { selectedIds: [] });
    await run.signal("format-selection", { items: [] });
    await run.signal("review", { decisions: [], approvedPieces: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });

  test("workflow is blocked at pain-point-selection after analyze completes", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "pain-point-collateral-analyze": AGENT_REPLY(
        JSON.stringify({
          painPoints: [{ id: "pp1", title: "T", detail: "D" }],
        }),
      ),
    });
    const { resolver } = makeRecordingActionResolver({
      [GRANOLA_LIST_NOTES_HANDLER]: { notes: [] },
      [GRANOLA_GET_NOTE_HANDLER]: { id: "note_1", title: "x" },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("note-selection", { noteId: "note_1" });
    await run.signal("context", { context: "" });

    // Wait for analyze
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === "pain-point-collateral-analyze")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // generate should NOT have run — blocked on pain-point-selection
    expect(ran.some((r) => r.id === "pain-point-collateral-generate")).toBe(
      false,
    );

    await run.signal("pain-point-selection", { selectedIds: ["pp1"] });
    await run.signal("format-selection", { items: [] });
    await run.signal("review", { decisions: [], approvedPieces: [] });
    await run.complete;
  });

  // -------------------------------------------------------------------------
  // awaitSignal step structure
  // -------------------------------------------------------------------------
  test("select is an awaitSignal step with name note-selection", () => {
    const select = workflow.steps.select;
    if (!select || select.kind !== "awaitSignal")
      throw new Error("expected awaitSignal");
    expect(select.name).toBe("note-selection");
  });

  test("context is an awaitSignal step with name context", () => {
    const ctx = workflow.steps.context;
    if (!ctx || ctx.kind !== "awaitSignal")
      throw new Error("expected awaitSignal");
    expect(ctx.name).toBe("context");
  });

  test("ppSelection is an awaitSignal step with name pain-point-selection", () => {
    const pp = workflow.steps.ppSelection;
    if (!pp || pp.kind !== "awaitSignal")
      throw new Error("expected awaitSignal");
    expect(pp.name).toBe("pain-point-selection");
  });

  test("fmtSelection is an awaitSignal step with name format-selection", () => {
    const fmt = workflow.steps.fmtSelection;
    if (!fmt || fmt.kind !== "awaitSignal")
      throw new Error("expected awaitSignal");
    expect(fmt.name).toBe("format-selection");
  });

  test("review is an awaitSignal step with name review", () => {
    const rev = workflow.steps.review;
    if (!rev || rev.kind !== "awaitSignal")
      throw new Error("expected awaitSignal");
    expect(rev.name).toBe("review");
  });

  // -------------------------------------------------------------------------
  // Timeout behaviour
  // -------------------------------------------------------------------------
  test("workflow with a short-timeout awaitSignal fails when signal does not arrive", async () => {
    const { invoker } = makeRecordingInvoker();

    const shortTimeoutDef = defineWorkflow({
      id: "ppc-timeout-test",
      trigger: { type: "manual" },
      steps: {
        analyze: step({
          agent: defineAgent({
            id: "stub-analyze",
            systemPrompt: "stub",
            tools: [],
            capabilities: [],
            inference: { sources: [{ provider: "fake", model: "fake" }] },
          }),
        }),
        review: awaitSignal({
          name: "review",
          timeout: 10,
          after: ["analyze"],
        }),
      },
    });

    const result = await runLocal(shortTimeoutDef, { invokeStep: invoker })
      .complete;
    expect(result.terminalStatus).toBe("failed");
    const stepFailed = result.events.find(
      (e) => e.kind === "StepFailed" && e.stepId === "review",
    );
    expect(stepFailed).toBeDefined();
  });
});
