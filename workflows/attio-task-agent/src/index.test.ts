import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";
import {
  CREATE_NOTE_HANDLER,
  description,
  GET_TASK_HANDLER,
  label,
  LIST_TASKS_HANDLER,
  LIST_WORKSPACE_MEMBERS_HANDLER,
  PERSIST_PIECES_HANDLER,
  UPDATE_TASK_HANDLER,
  workflow,
} from "./index";

// The retired `deterministic-tool` authoring kind's tag. Kept as a literal
// (not an import from `@workbench/agents`, which no longer exports it) —
// this test only asserts the tag is ABSENT from every native step, proving
// no step regresses onto the deleted mechanism.
const STEP_KIND_TAG = "workbench.stepKind";

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
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
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
      "attio-task-agent-suggest": "Sent the draft. Next: schedule a follow-up.",
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [LIST_WORKSPACE_MEMBERS_HANDLER]: {
        members: [
          { id: { workspace_member_id: "wm_1" }, email: "me@abklabs.com" },
        ],
      },
      [LIST_TASKS_HANDLER]: {
        tasks: [{ id: { task_id: "task_1" }, content_plaintext: "Reach out" }],
      },
      [GET_TASK_HANDLER]: {
        task: { id: { task_id: "task_1" } },
        linkedRecords: [{ object: "companies", recordId: "rec_1" }],
      },
      [PERSIST_PIECES_HANDLER]: { results: [{ artifactId: "art_1" }] },
      [CREATE_NOTE_HANDLER]: { id: { note_id: "note_1" } },
      [UPDATE_TASK_HANDLER]: { id: { task_id: "task_1" } },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

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
      content: "Drafted outreach.",
      taskId: "task_1",
      idempotencyKey: "task_1",
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("attio-task-agent-analyze");
    expect(ranIds).toContain("attio-task-agent-execute");
    expect(ranIds).toContain("attio-task-agent-review-artifacts");

    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).toContain(LIST_WORKSPACE_MEMBERS_HANDLER);
    expect(actionRefs).toContain(LIST_TASKS_HANDLER);
    expect(actionRefs).toContain(GET_TASK_HANDLER);
    expect(actionRefs).toContain(PERSIST_PIECES_HANDLER);
    expect(actionRefs).toContain(CREATE_NOTE_HANDLER);
    expect(actionRefs).toContain(UPDATE_TASK_HANDLER);

    // The executor runs AFTER the planner and BEFORE the agent reviewer.
    expect(ranIds.indexOf("attio-task-agent-analyze")).toBeLessThan(
      ranIds.indexOf("attio-task-agent-execute"),
    );
    expect(ranIds.indexOf("attio-task-agent-execute")).toBeLessThan(
      ranIds.indexOf("attio-task-agent-review-artifacts"),
    );

    // writeNote runs strictly before writeComplete (note-first ordering).
    const noteIndex = actionsRan.findIndex(
      (r) => r.handler === CREATE_NOTE_HANDLER,
    );
    const completeIndex = actionsRan.findIndex(
      (r) => r.handler === UPDATE_TASK_HANDLER,
    );
    expect(noteIndex).toBeLessThan(completeIndex);
  });

  test("analyze is the PLANNER: a tool-capable step grounded in READ-ONLY tools", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(analyze.agent.systemPrompt).toContain(
      "Corbits, Corbits.dev, Interchange, and Faremeter",
    );
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

  test("listMembers and listTasks are native action primitives — no Workbench dispatch tags, no agent", () => {
    const members = actionPrimitive("listMembers");
    expect(members.handler).toBe(LIST_WORKSPACE_MEMBERS_HANDLER);
    // No `input` selector needed: `{ literal: {} }` pins the no-arg tool's
    // args regardless of the trigger payload (replaces the old empty-argMap
    // workaround, CL-2658).
    expect(members.input).toEqual({ literal: {} });
    expect(members.effect).toEqual({
      requires: [LIST_WORKSPACE_MEMBERS_HANDLER],
    });
    expect("agent" in members).toBe(false);

    const list = actionPrimitive("listTasks");
    expect(list.handler).toBe(LIST_TASKS_HANDLER);
    expect(list.input).toEqual({
      merge: [
        { from: "steps.selectMember.output" },
        { literal: { isCompleted: false } },
      ],
    });
    expect(list.effect).toEqual({ requires: [LIST_TASKS_HANDLER] });

    const fetch = actionPrimitive("fetchTask");
    expect(fetch.handler).toBe(GET_TASK_HANDLER);
    expect(fetch.input).toEqual({ from: "steps.selectTask.output" });
    expect(fetch.effect).toEqual({ requires: [GET_TASK_HANDLER] });
  });

  test("execute is a single inline EXECUTOR step over the whole plan (not a per-kind fan-out)", () => {
    // There is no human kind-picker step and no per-kind gen/gate steps.
    expect(workflow.steps.selectKinds).toBeUndefined();
    expect(workflow.steps["gen-cold-email"]).toBeUndefined();
    expect(workflow.steps["gate-cold-email"]).toBeUndefined();

    const exec = stepPrimitive("execute");
    expect(exec.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
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
    const review = stepPrimitive("reviewArtifacts");
    expect(review.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(review.input).toEqual({ from: "steps.execute.output" });
    expect(review.agent.systemPrompt).toContain("verdict");
  });

  test("suggest is a native reasoning step (agentStep) on the cheaper default model", () => {
    const s = stepPrimitive("suggest");
    expect(s.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(s.agent.capabilities).toEqual([]);
    expect(s.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(s.agent.inference.sources).toEqual([]);
  });

  test("persist is a native action dispatching the batch persist-pieces handler over review.output", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(PERSIST_PIECES_HANDLER);
    expect(persist.input).toEqual({ from: "steps.review.output" });
    expect(persist.effect).toEqual({ requires: [PERSIST_PIECES_HANDLER] });
  });

  test("destructive write-back stays gated on an explicit confirm flag, as native FATAL action primitives", () => {
    const syncGate = workflow.steps.syncGate;
    if (!syncGate || syncGate.kind !== "gate") {
      throw new Error("expected a gate for syncGate");
    }
    expect(syncGate.when).toEqual({ from: "steps.approveSync.output.confirm" });
    expect(syncGate.then).toBe("writeNote");
    expect(syncGate.else).toBe("skipWriteBack");
    expect(workflow.steps.skipWriteBack?.kind).toBe("sleep");

    const note = actionPrimitive("writeNote");
    expect(note.handler).toBe(CREATE_NOTE_HANDLER);
    expect(note.effect).toEqual({ requires: [CREATE_NOTE_HANDLER] });
    // The sync-approval payload already is attio_create_note's arguments
    // (content/idempotencyKey/parentObject/parentRecordId) — no reshape.
    expect(note.input).toEqual({ from: "steps.approveSync.output" });
    // Native actions carry no Workbench dispatch tags at all — there is
    // nothing for a `STEP_NONFATAL_TAG` to hang off, so a real Attio error
    // always propagates and fails the step (FATAL by construction).
    expect("agent" in note).toBe(false);

    const complete = actionPrimitive("writeComplete");
    expect(complete.handler).toBe(UPDATE_TASK_HANDLER);
    expect(complete.effect).toEqual({ requires: [UPDATE_TASK_HANDLER] });
    expect(complete.input).toEqual({
      merge: [
        { project: { from: "steps.approveSync.output" }, fields: ["taskId"] },
        { literal: { isCompleted: true } },
      ],
    });
    expect("agent" in complete).toBe(false);
  });

  test("declining the write-back routes to the no-op skip leaf, not a write", async () => {
    const { invoker } = makeRecordingInvoker({
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
      "attio-task-agent-suggest": "done",
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [LIST_WORKSPACE_MEMBERS_HANDLER]: { members: [] },
      [LIST_TASKS_HANDLER]: { tasks: [] },
      [GET_TASK_HANDLER]: { task: {}, linkedRecords: [] },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("member-selection", { assignee: "x" });
    await run.signal("task-selection", { taskId: "task_1" });
    await run.signal("clarification", { answers: "" });
    await run.signal("review", {
      approvedPieces: [{ type: "cold-email", title: "T", content: "C" }],
    });
    await run.signal("sync-approval", { confirm: false });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).not.toContain(CREATE_NOTE_HANDLER);
    expect(actionRefs).not.toContain(UPDATE_TASK_HANDLER);
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
