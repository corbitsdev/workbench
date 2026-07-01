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
import { attioTaskArtifactKinds } from "@workbench/shared";
import { description, label, workflow } from "./index";

// The panel always emits a COMPLETE boolean map so no per-kind gate reads a
// missing key. `on` lists the kinds to enable; the rest are false.
function kindSelection(on: string[]): { generate: Record<string, boolean> } {
  const generate: Record<string, boolean> = {};
  for (const kind of attioTaskArtifactKinds) generate[kind] = on.includes(kind);
  return { generate };
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
      selectedArtifactKinds: [
        { kind: "cold-email" },
        { kind: "research-brief" },
      ],
      proposedTaskUpdate: { markComplete: true, note: "Drafted outreach." },
    };
    const { invoker, ran } = makeRecordingInvoker({
      "attio-task-agent-list-members": {
        members: [
          { id: { workspace_member_id: "wm_1" }, email: "me@abklabs.com" },
        ],
      },
      "attio-task-agent-list-tasks": {
        tasks: [{ id: { task_id: "task_1" }, content_plaintext: "Reach out" }],
      },
      "attio-task-agent-fetch-task": {
        task: { id: { task_id: "task_1" } },
        linkedRecords: [{ object: "companies", recordId: "rec_1" }],
      },
      "attio-task-agent-analyze": decision,
      "attio-task-agent-gen-cold-email": {
        kind: "cold-email",
        title: "Outreach",
        content: "Hi…",
      },
      "attio-task-agent-persist": { artifactId: "art_1" },
      "attio-task-agent-suggest": "Sent the draft. Next: schedule a follow-up.",
      "attio-task-agent-write-note": { id: { note_id: "note_1" } },
      "attio-task-agent-write-complete": { id: { task_id: "task_1" } },
    });

    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("member-selection", { assignee: "me@abklabs.com" });
    await run.signal("task-selection", { taskId: "task_1" });
    await run.signal("clarification", { answers: "" });
    await run.signal("kind-selection", kindSelection(["cold-email"]));
    await run.signal("review", {
      approvedPieces: [
        { kind: "cold-email", title: "Outreach", content: "Hi…" },
      ],
    });
    await run.signal("sync-approval", {
      confirm: true,
      parentObject: "companies",
      parentRecordId: "rec_1",
      note: "Drafted outreach.",
      taskId: "task_1",
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("attio-task-agent-list-members");
    expect(ranIds).toContain("attio-task-agent-list-tasks");
    expect(ranIds).toContain("attio-task-agent-fetch-task");
    expect(ranIds).toContain("attio-task-agent-analyze");
    expect(ranIds).toContain("attio-task-agent-gen-cold-email");
    // A non-selected kind's writer step never runs (its branch is pruned).
    expect(ranIds).not.toContain("attio-task-agent-gen-blog");
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

  test("listMembers and listTasks are deterministic; listTasks is scoped to the selected member", () => {
    const members = stepPrimitive("listMembers");
    expect(members.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "attio_list_workspace_members",
    );

    const list = stepPrimitive("listTasks");
    expect(list.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(list.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_list_tasks");
    expect(list.input).toEqual({ from: "steps.selectMember.output" });
    expect(JSON.parse(list.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}")).toEqual({
      assignee: { from: "assignee" },
      isCompleted: { literal: false },
    });

    const fetch = stepPrimitive("fetchTask");
    expect(fetch.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_get_task");
    expect(fetch.input).toEqual({ from: "steps.selectTask.output" });
  });

  test("each artifact kind routes through its own gate to its own dedicated-prompt writer step", () => {
    // A gate per kind, reading that kind's boolean from the selectKinds payload.
    const gateStep = workflow.steps["gate-linkedin-post"];
    if (!gateStep || gateStep.kind !== "gate") {
      throw new Error("expected a gate for linkedin-post");
    }
    expect(gateStep.when).toEqual({
      from: "steps.selectKinds.output.generate.linkedin-post",
    });
    expect(gateStep.then).toBe("gen-linkedin-post");
    expect(gateStep.else).toBe("skip-linkedin-post");

    // Each writer step is an inline-inference step on the writer model, and its
    // prompt is dedicated to that kind (no other kind's guidance bleeds in).
    const gen = stepPrimitive("gen-linkedin-post");
    expect(gen.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(gen.agent.inference.sources.length).toBe(1);
    expect(gen.agent.systemPrompt).toContain("ANONYMIZED");
    expect(gen.agent.systemPrompt).not.toContain("cold outreach");

    // The skip branch is a no-op sleep leaf (no wasted inference).
    expect(workflow.steps["skip-linkedin-post"]?.kind).toBe("sleep");
  });

  test("suggest is an inline-inference step on the cheaper default model", () => {
    const s = stepPrimitive("suggest");
    expect(s.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(s.agent.capabilities).toEqual([]);
    expect(s.agent.systemPrompt.length).toBeGreaterThan(0);
    // no preferred source → falls back to the deploy default.
    expect(s.agent.inference.sources).toEqual([]);
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

  test("write-back is gated on an explicit confirm flag with FATAL writes (no swallowed errors)", () => {
    const syncGate = workflow.steps.syncGate;
    if (!syncGate || syncGate.kind !== "gate") {
      throw new Error("expected a gate for syncGate");
    }
    expect(syncGate.when).toEqual({ from: "steps.approveSync.output.confirm" });
    expect(syncGate.then).toBe("writeNote");
    expect(syncGate.else).toBe("skipWriteBack");
    // The skip is a no-op sleep leaf — no wasted LLM call.
    expect(workflow.steps.skipWriteBack?.kind).toBe("sleep");

    const note = stepPrimitive("writeNote");
    expect(note.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_create_note");
    // FATAL now — a real Attio failure must fail the run, not be swallowed.
    expect(note.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
    const noteArgMap = JSON.parse(note.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}");
    expect(noteArgMap.content).toEqual({ from: "note" });
    // Keyed by task id so a re-run dedupes the note instead of duplicating it.
    expect(noteArgMap.idempotencyKey).toEqual({ from: "taskId" });

    const complete = stepPrimitive("writeComplete");
    expect(complete.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_update_task");
    expect(complete.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
  });

  test("declining the write-back routes to the no-op skip leaf, not a write", async () => {
    const decision = {
      status: "ready",
      selectedArtifactKinds: [{ kind: "cold-email" }],
    };
    const { invoker, ran } = makeRecordingInvoker({
      "attio-task-agent-list-members": { members: [] },
      "attio-task-agent-list-tasks": { tasks: [] },
      "attio-task-agent-fetch-task": { task: {}, linkedRecords: [] },
      "attio-task-agent-analyze": decision,
      "attio-task-agent-gen-cold-email": {
        kind: "cold-email",
        title: "T",
        content: "C",
      },
      "attio-task-agent-persist": { artifactId: "a" },
      "attio-task-agent-suggest": "done",
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("member-selection", { assignee: "x" });
    await run.signal("task-selection", { taskId: "task_1" });
    await run.signal("clarification", { answers: "" });
    await run.signal("kind-selection", kindSelection(["cold-email"]));
    await run.signal("review", {
      approvedPieces: [{ kind: "cold-email", title: "T", content: "C" }],
    });
    await run.signal("sync-approval", { confirm: false });
    const result = await run.complete;
    // Declined: the run completes via the skip leaf, and neither write ran.
    expect(result.terminalStatus).toBe("completed");
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).not.toContain("attio-task-agent-write-note");
    expect(ranIds).not.toContain("attio-task-agent-write-complete");
  });

  test("HITL gates carry the expected signal names", () => {
    expect(awaitSignalPrimitive("selectMember").name).toBe("member-selection");
    expect(awaitSignalPrimitive("selectTask").name).toBe("task-selection");
    expect(awaitSignalPrimitive("clarify").name).toBe("clarification");
    expect(awaitSignalPrimitive("selectKinds").name).toBe("kind-selection");
    expect(awaitSignalPrimitive("review").name).toBe("review");
    expect(awaitSignalPrimitive("approveSync").name).toBe("sync-approval");
  });
});
