import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  ArtifactReviewSchema,
  AttioAnalyzeDecisionSchema,
  ExecutorOutputSchema,
  SyncApprovalPayloadSchema,
  artifactKindRegistry,
  attioTaskArtifactKinds,
  nextLoopAction,
  normalizeAttioTask,
  resolveArtifactKinds,
} from "./attio-task-agent";

const RAW_TASK = {
  id: { workspace_id: "ws_1", task_id: "task_1" },
  content_plaintext: "Follow up with Acme about the pilot",
  deadline_at: "2026-07-10T00:00:00Z",
  is_completed: false,
  assignees: [
    { referenced_actor_type: "workspace-member", referenced_actor_id: "wm_1" },
  ],
  linked_records: [{ target_object: "companies", target_record_id: "rec_1" }],
};

describe("normalizeAttioTask", () => {
  it("normalizes the nested Attio task shape", () => {
    expect(normalizeAttioTask(RAW_TASK)).toEqual({
      taskId: "task_1",
      content: "Follow up with Acme about the pilot",
      deadlineAt: "2026-07-10T00:00:00Z",
      isCompleted: false,
      assigneeIds: ["wm_1"],
      linkedRecords: [{ object: "companies", recordId: "rec_1" }],
    });
  });

  it("defaults missing collections and deadline", () => {
    const task = normalizeAttioTask({
      id: { task_id: "task_2" },
      content_plaintext: "Ping",
    });
    expect(task).toEqual({
      taskId: "task_2",
      content: "Ping",
      deadlineAt: null,
      isCompleted: false,
      assigneeIds: [],
      linkedRecords: [],
    });
  });

  it("falls back to target_object_id when target_object is absent", () => {
    const task = normalizeAttioTask({
      id: { task_id: "task_3" },
      content_plaintext: "x",
      linked_records: [
        { target_object_id: "obj_9", target_record_id: "rec_9" },
      ],
    });
    expect(task?.linkedRecords).toEqual([
      { object: "obj_9", recordId: "rec_9" },
    ]);
  });

  it("returns null when the task id is missing", () => {
    expect(normalizeAttioTask({ content_plaintext: "x" })).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(normalizeAttioTask("nope")).toBeNull();
  });
});

describe("artifactKindRegistry", () => {
  it("has an entry for every declared kind", () => {
    for (const kind of attioTaskArtifactKinds) {
      expect(artifactKindRegistry[kind]?.key).toBe(kind);
      expect(artifactKindRegistry[kind]?.label.length).toBeGreaterThan(0);
    }
  });

  it("marks the social posts as anonymized and emails as not", () => {
    expect(artifactKindRegistry["twitter-post"].anonymized).toBe(true);
    expect(artifactKindRegistry["linkedin-post"].anonymized).toBe(true);
    expect(artifactKindRegistry["cold-email"].anonymized).toBe(false);
  });
});

describe("resolveArtifactKinds", () => {
  it("partitions known from unknown and dedupes", () => {
    expect(
      resolveArtifactKinds([
        "cold-email",
        "cold-email",
        "linkedin-post",
        "smoke-signal",
      ]),
    ).toEqual({
      valid: ["cold-email", "linkedin-post"],
      unknown: ["smoke-signal"],
    });
  });

  it("returns empty lists for empty input", () => {
    expect(resolveArtifactKinds([])).toEqual({ valid: [], unknown: [] });
  });
});

describe("nextLoopAction", () => {
  it("generates when the decision is ready", () => {
    expect(nextLoopAction("ready", 0, 3)).toBe("generate");
  });

  it("clarifies when the decision needs clarification", () => {
    expect(nextLoopAction("need_clarification", 0, 3)).toBe("clarify");
  });

  it("gathers again when more context is needed and rounds remain", () => {
    expect(nextLoopAction("need_more_context", 1, 3)).toBe("gather");
  });

  it("forces generation when the round cap is reached", () => {
    expect(nextLoopAction("need_more_context", 2, 3)).toBe("generate");
  });
});

describe("AttioAnalyzeDecisionSchema", () => {
  it("accepts a ready decision with a draft-action plan", () => {
    const out = AttioAnalyzeDecisionSchema({
      status: "ready",
      reasoning: "Have enough context",
      draftActions: [
        { type: "cold-email", brief: "Draft first-touch outreach to Acme." },
        { type: "research-brief", brief: "Summarize Acme's recent funding." },
      ],
      proposedTaskUpdate: { markComplete: true, note: "Drafted outreach" },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects an unknown status", () => {
    const out = AttioAnalyzeDecisionSchema({
      status: "vibing",
      reasoning: "x",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("rejects a draft action missing its brief", () => {
    const out = AttioAnalyzeDecisionSchema({
      status: "ready",
      reasoning: "x",
      draftActions: [{ type: "cold-email" }],
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("accepts an arbitrary (non-collateral) action type", () => {
    // `type` is a free string so a new action (e.g. a slack-message draft) is a
    // registry addition, not a schema change (CL-2664).
    const out = AttioAnalyzeDecisionSchema({
      status: "ready",
      reasoning: "x",
      draftActions: [
        { type: "slack-message", brief: "Draft a heads-up to #bd." },
      ],
    });
    expect(out instanceof type.errors).toBe(false);
  });
});

describe("ExecutorOutputSchema", () => {
  it("accepts the executor's produced outputs", () => {
    const out = ExecutorOutputSchema({
      outputs: [{ type: "cold-email", title: "Acme outreach", content: "Hi…" }],
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts an empty plan result", () => {
    expect(ExecutorOutputSchema({ outputs: [] }) instanceof type.errors).toBe(
      false,
    );
  });
});

describe("ArtifactReviewSchema", () => {
  it("accepts a per-output verdict list", () => {
    const out = ArtifactReviewSchema({
      overall: "Both outputs fulfil their briefs.",
      items: [
        { type: "cold-email", verdict: "pass", notes: "Send-ready." },
        {
          type: "research-brief",
          verdict: "revise",
          notes: "Cite the source.",
        },
      ],
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    const out = ArtifactReviewSchema({
      overall: "x",
      items: [{ type: "cold-email", verdict: "meh", notes: "" }],
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("SyncApprovalPayloadSchema", () => {
  it("accepts a confirm payload with record locators and content", () => {
    const out = SyncApprovalPayloadSchema({
      confirm: true,
      taskId: "task_1",
      idempotencyKey: "task_1",
      parentObject: "companies",
      parentRecordId: "rec_1",
      content: "Attached outreach",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts a bare skip payload", () => {
    const out = SyncApprovalPayloadSchema({ confirm: false });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a non-boolean confirm", () => {
    const out = SyncApprovalPayloadSchema({ confirm: "yes" });
    expect(out instanceof type.errors).toBe(true);
  });

  it("rejects a confirm=true missing the write locators (CL-2684)", () => {
    // A destructive confirm must carry the full locators; a bare confirm would
    // fire attio_create_note against nothing.
    expect(
      SyncApprovalPayloadSchema({ confirm: true }) instanceof type.errors,
    ).toBe(true);
    expect(
      SyncApprovalPayloadSchema({
        confirm: true,
        taskId: "task_1",
        idempotencyKey: "task_1",
        parentObject: "companies",
        parentRecordId: "rec_1",
        content: "",
      }) instanceof type.errors,
    ).toBe(true);
  });
});
