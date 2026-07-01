import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  AttioAnalyzeDecisionSchema,
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
  it("accepts a ready decision with selected kinds", () => {
    const out = AttioAnalyzeDecisionSchema({
      status: "ready",
      reasoning: "Have enough context",
      selectedArtifactKinds: ["cold-email", "research-brief"],
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

  it("rejects an unknown artifact kind", () => {
    const out = AttioAnalyzeDecisionSchema({
      status: "ready",
      reasoning: "x",
      selectedArtifactKinds: ["cold-email", "hologram"],
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
