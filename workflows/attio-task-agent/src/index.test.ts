import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_NONFATAL_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import { description, label, workflow } from "./index";

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

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
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

function awaitSignalPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "awaitSignal") {
    throw new Error(
      `expected awaitSignal primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("attio-task-agent native workflow", () => {
  test("metadata is exported", () => {
    expect(workflow.id).toBe("attio-task-agent");
    expect(label.length).toBeGreaterThan(0);
    expect(description.length).toBeGreaterThan(0);
  });

  test("runs the full flow: list → select → fetch → analyze → clarify → generate → review → persist → suggest → approveSync → write-back", async () => {
    const decision = {
      status: "ready",
      reasoning: "Have enough context.",
      selectedArtifactKinds: ["cold-email", "research-brief"],
      proposedTaskUpdate: { markComplete: true, note: "Drafted outreach." },
    };
    const { invoker, ran } = makeRecordingInvoker({
      "attio-task-agent-list-tasks": {
        tasks: [{ id: { task_id: "task_1" }, content_plaintext: "Reach out" }],
      },
      "attio-task-agent-fetch-task": {
        task: { id: { task_id: "task_1" } },
        linkedRecords: [{ object: "companies", recordId: "rec_1" }],
      },
      "attio-task-agent-analyze": decision,
      "attio-task-agent-generate": {
        artifacts: [{ kind: "cold-email", title: "Outreach", content: "Hi…" }],
      },
      "attio-task-agent-persist": { artifactId: "art_1" },
      "attio-task-agent-suggest": "Sent the draft. Next: schedule a follow-up.",
      "attio-task-agent-write-note": { id: { note_id: "note_1" } },
      "attio-task-agent-write-complete": { id: { task_id: "task_1" } },
    });

    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("task-selection", { taskId: "task_1" });
    await run.signal("clarification", { answers: "" });
    await run.signal("review", {
      approvedPieces: [
        { kind: "cold-email", title: "Outreach", content: "Hi…" },
      ],
    });
    await run.signal("sync-approval", {
      parentObject: "companies",
      parentRecordId: "rec_1",
      note: "Drafted outreach.",
      markComplete: true,
      taskId: "task_1",
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("attio-task-agent-list-tasks");
    expect(ranIds).toContain("attio-task-agent-fetch-task");
    expect(ranIds).toContain("attio-task-agent-analyze");
    expect(ranIds).toContain("attio-task-agent-generate");
    expect(ranIds).toContain("attio-task-agent-persist");
    expect(ranIds).toContain("attio-task-agent-write-note");
    expect(ranIds).toContain("attio-task-agent-write-complete");
  });

  test("analyze is a tool-capable step grounded in READ-ONLY tools", () => {
    const analyze = stepPrimitive("analyze");
    // A full tool-capable step — NOT a deterministic or inline marker.
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    const caps = analyze.agent.capabilities.join(" ");
    expect(caps).toContain("attio_get_task");
    expect(caps).toContain("granola_get_note");
    expect(caps).toContain("exa_search");
    expect(caps).toContain("artifact_read");
  });

  test("the gather agent CANNOT write to Attio (no write tools in its grants)", () => {
    const caps = stepPrimitive("analyze").agent.capabilities.join(" ");
    expect(caps).not.toContain("attio_update_task");
    expect(caps).not.toContain("attio_create_note");
    expect(caps).not.toContain("artifact_create");
  });

  test("listTasks and fetchTask are deterministic tool steps", () => {
    const list = stepPrimitive("listTasks");
    expect(list.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(list.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_list_tasks");
    expect(list.input).toEqual({ literal: { isCompleted: false } });

    const fetch = stepPrimitive("fetchTask");
    expect(fetch.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_get_task");
    expect(fetch.input).toEqual({ from: "steps.selectTask.output" });
  });

  test("generate and suggest are inline-inference steps", () => {
    for (const id of ["generate", "suggest"]) {
      const s = stepPrimitive(id);
      expect(s.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
      expect(s.agent.capabilities).toEqual([]);
      expect(s.agent.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  test("persist maps artifact_create over the approved pieces", () => {
    const persist = mapPrimitive("persist");
    expect(persist.over).toEqual({
      from: "steps.review.output.approvedPieces",
    });
    const inner = persist.step;
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toContain("artifact_create");
    const argMap = inner.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined) throw new Error("expected argMap on persist");
    expect(JSON.parse(argMap)).toEqual({
      title: { from: "title" },
      kind: { from: "kind" },
      content: { from: "content" },
    });
  });

  test("write-back steps are deterministic, non-fatal, and human-gated on the approval signal", () => {
    const note = stepPrimitive("writeNote");
    expect(note.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_create_note");
    expect(note.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
    expect(note.input).toEqual({ from: "steps.approveSync.output" });
    expect(
      JSON.parse(note.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}").content,
    ).toEqual({ from: "note" });

    const complete = stepPrimitive("writeComplete");
    expect(complete.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_update_task");
    expect(complete.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
  });

  test("HITL gates carry the expected signal names", () => {
    expect(awaitSignalPrimitive("selectTask").name).toBe("task-selection");
    expect(awaitSignalPrimitive("clarify").name).toBe("clarification");
    expect(awaitSignalPrimitive("review").name).toBe("review");
    expect(awaitSignalPrimitive("approveSync").name).toBe("sync-approval");
  });
});
