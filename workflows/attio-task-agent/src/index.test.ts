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

function inlinePrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected inline step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
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

  test("runs the full pipeline: list → select → fetch → PLAN → clarify → EXECUTE → REVIEW(agent) → review(human) → persist → suggest → write-back — with NO human action-picker", async () => {
    const decision = {
      status: "ready",
      reasoning: "Have enough context.",
      draftActions: [
        { type: "cold-email", brief: "Draft first-touch outreach to Acme." },
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
      "attio-task-agent-execute": {
        outputs: [
          {
            type: "cold-email",
            title: "Outreach",
            content: "Hi…",
            brief: "Draft first-touch outreach to Acme.",
          },
        ],
      },
      "attio-task-agent-review-artifacts": {
        overall: "Send-ready.",
        items: [{ type: "cold-email", verdict: "pass", notes: "Good." }],
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
    // NOTE: no "kind-selection" signal — the agent decided the plan.
    await run.signal("review", {
      approvedPieces: [
        { type: "cold-email", title: "Outreach", content: "Hi…" },
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
    expect(ranIds).toContain("attio-task-agent-analyze");
    expect(ranIds).toContain("attio-task-agent-execute");
    expect(ranIds).toContain("attio-task-agent-review-artifacts");
    expect(ranIds).toContain("attio-task-agent-persist");
    expect(ranIds).toContain("attio-task-agent-write-note");
    expect(ranIds).toContain("attio-task-agent-write-complete");

    // The executor runs AFTER the planner and BEFORE the agent reviewer.
    expect(ranIds.indexOf("attio-task-agent-analyze")).toBeLessThan(
      ranIds.indexOf("attio-task-agent-execute"),
    );
    expect(ranIds.indexOf("attio-task-agent-execute")).toBeLessThan(
      ranIds.indexOf("attio-task-agent-review-artifacts"),
    );
  });

  test("analyze is the PLANNER: a tool-capable step grounded in READ-ONLY tools", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    const caps = analyze.agent.capabilities.join(" ");
    expect(caps).toContain("attio_get_task");
    expect(caps).toContain("granola_get_note");
    expect(caps).toContain("exa_search");
    expect(caps).toContain("artifact_read");
  });

  test("the planner CANNOT write to Attio (no write tools in its grants)", () => {
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
    // Empty argMap pins the no-arg tool to {} regardless of the trigger (CL-2658).
    expect(JSON.parse(members.agent.tags?.[STEP_ARGMAP_TAG] ?? "null")).toEqual(
      {},
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

  test("execute is a single inline EXECUTOR step over the whole plan (not a per-kind fan-out)", () => {
    // There is no human kind-picker step and no per-kind gen/gate steps.
    expect(workflow.steps.selectKinds).toBeUndefined();
    expect(workflow.steps["gen-cold-email"]).toBeUndefined();
    expect(workflow.steps["gate-cold-email"]).toBeUndefined();

    const exec = inlinePrimitive("execute");
    expect(exec.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    // It sees the plan + task + clarification (merged; envelope keys don't collide).
    expect(exec.input).toEqual({
      merge: [
        { from: "steps.analyze.output" },
        { from: "steps.fetchTask.output" },
        { from: "steps.clarify.output" },
      ],
    });
    // The executor prompt carries guidance for producing any action type.
    expect(exec.agent.systemPrompt).toContain("ANONYMIZED");
    expect(exec.agent.systemPrompt).toContain("cold outreach");
  });

  test("reviewArtifacts is the agent REVIEWER, reading the executor's outputs before the human", () => {
    const review = inlinePrimitive("reviewArtifacts");
    expect(review.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(review.input).toEqual({ from: "steps.execute.output" });
    expect(review.agent.systemPrompt).toContain("verdict");
  });

  test("suggest is an inline-inference step on the cheaper default model", () => {
    const s = stepPrimitive("suggest");
    expect(s.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(s.agent.capabilities).toEqual([]);
    expect(s.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(s.agent.inference.sources).toEqual([]);
  });

  test("persist maps artifact_create over the approved pieces, keying artifact kind off the action type", () => {
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
      kind: { from: "type" },
      content: { from: "content" },
    });
  });

  test("destructive write-back stays gated on an explicit confirm flag with FATAL writes", () => {
    const syncGate = workflow.steps.syncGate;
    if (!syncGate || syncGate.kind !== "gate") {
      throw new Error("expected a gate for syncGate");
    }
    expect(syncGate.when).toEqual({ from: "steps.approveSync.output.confirm" });
    expect(syncGate.then).toBe("writeNote");
    expect(syncGate.else).toBe("skipWriteBack");
    expect(workflow.steps.skipWriteBack?.kind).toBe("sleep");

    const note = stepPrimitive("writeNote");
    expect(note.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_create_note");
    expect(note.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
    const noteArgMap = JSON.parse(note.agent.tags?.[STEP_ARGMAP_TAG] ?? "{}");
    expect(noteArgMap.content).toEqual({ from: "note" });
    expect(noteArgMap.idempotencyKey).toEqual({ from: "taskId" });

    const complete = stepPrimitive("writeComplete");
    expect(complete.agent.tags?.[STEP_TOOL_TAG]).toContain("attio_update_task");
    expect(complete.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
  });

  test("declining the write-back routes to the no-op skip leaf, not a write", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "attio-task-agent-list-members": { members: [] },
      "attio-task-agent-list-tasks": { tasks: [] },
      "attio-task-agent-fetch-task": { task: {}, linkedRecords: [] },
      "attio-task-agent-analyze": {
        status: "ready",
        reasoning: "x",
        draftActions: [{ type: "cold-email", brief: "b" }],
      },
      "attio-task-agent-execute": {
        outputs: [{ type: "cold-email", title: "T", content: "C" }],
      },
      "attio-task-agent-review-artifacts": {
        overall: "ok",
        items: [{ type: "cold-email", verdict: "pass", notes: "" }],
      },
      "attio-task-agent-persist": { artifactId: "a" },
      "attio-task-agent-suggest": "done",
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("member-selection", { assignee: "x" });
    await run.signal("task-selection", { taskId: "task_1" });
    await run.signal("clarification", { answers: "" });
    await run.signal("review", {
      approvedPieces: [{ type: "cold-email", title: "T", content: "C" }],
    });
    await run.signal("sync-approval", { confirm: false });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).not.toContain("attio-task-agent-write-note");
    expect(ranIds).not.toContain("attio-task-agent-write-complete");
  });

  test("HITL gates carry the expected signal names — and there is no kind-selection gate", () => {
    expect(awaitSignalPrimitive("selectMember").name).toBe("member-selection");
    expect(awaitSignalPrimitive("selectTask").name).toBe("task-selection");
    expect(awaitSignalPrimitive("clarify").name).toBe("clarification");
    expect(awaitSignalPrimitive("review").name).toBe("review");
    expect(awaitSignalPrimitive("approveSync").name).toBe("sync-approval");
    expect(workflow.steps.selectKinds).toBeUndefined();
  });
});
