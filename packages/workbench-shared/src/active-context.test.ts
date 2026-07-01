import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  ARTIFACT_BODY_MAX_CHARS,
  ActiveContextSchema,
  THREAD_MAX_TURNS,
  THREAD_TURN_MAX_CHARS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_OUTPUT_MAX_CHARS,
  activeContextToRef,
  projectActiveContext,
  type ActiveContext,
  type ThreadContext,
  type WorkflowRunContext,
} from "./active-context";

describe("ActiveContextSchema", () => {
  test("accepts a well-formed artifact context and rejects an unknown kind", () => {
    const ok = ActiveContextSchema({
      kind: "artifact",
      id: "art_1",
      label: "Q3 one-pager",
      artifactKind: "one-pager",
      body: "hello",
    });
    expect(ok instanceof type.errors).toBe(false);

    const bad = ActiveContextSchema({
      kind: "spaceship",
      id: "x",
      label: "X",
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});

describe("activeContextToRef", () => {
  test("derives the pill ref and drops the heavy projection payload", () => {
    const ctx: ActiveContext = {
      kind: "artifact",
      id: "art_1",
      label: "Q3 one-pager",
      artifactKind: "one-pager",
      body: "x".repeat(5000),
    };
    expect(activeContextToRef(ctx)).toEqual({
      kind: "artifact",
      id: "art_1",
      label: "Q3 one-pager",
    });
  });
});

describe("artifact projector", () => {
  const ctx: ActiveContext = {
    kind: "artifact",
    id: "art_42",
    label: "Launch brief",
    artifactKind: "blog",
    // A tail sentinel that must NOT survive truncation.
    body: `${"a".repeat(ARTIFACT_BODY_MAX_CHARS + 500)}TAIL_SENTINEL`,
  };

  test("emits identity fields and an artifact_read instruction", () => {
    const { leadIn } = projectActiveContext(ctx);
    expect(leadIn).toContain('artifact "Launch brief"');
    expect(leadIn).toContain("art_42");
    expect(leadIn).toContain("kind: blog");
    expect(leadIn).toContain("artifact_read");
  });

  test("truncates the body rather than dumping the full entity", () => {
    const { leadIn } = projectActiveContext(ctx);
    expect(leadIn).not.toContain("TAIL_SENTINEL");
    expect(leadIn).toContain("…");
    // Bounded: framing lines are small, so the whole lead-in stays near the cap.
    expect(leadIn.length).toBeLessThan(ARTIFACT_BODY_MAX_CHARS + 300);
  });

  test("attachment carries the same projection as text/markdown", () => {
    const { leadIn, attachment } = projectActiveContext(ctx);
    expect(attachment.contentType).toBe("text/markdown");
    expect(attachment.name).toContain("art_42");
    expect(new TextDecoder().decode(attachment.data)).toBe(leadIn);
  });
});

describe("workflow-run projector", () => {
  const ctx: WorkflowRunContext = {
    kind: "workflow-run",
    id: "run_7",
    label: "MVT Landing Page",
    runKind: "mvt-landing-page",
    status: "awaiting",
    inputs: "company=Acme",
    steps: Array.from({ length: WORKFLOW_MAX_STEPS + 8 }, (_, i) => ({
      name: `step_${i}`,
      status: i === 0 ? "current" : "done",
      output: `${"o".repeat(WORKFLOW_STEP_OUTPUT_MAX_CHARS + 200)}STEP_TAIL`,
    })),
    artifactsProduced: ["art_a", "art_b"],
  };

  test("emits run identity, status, inputs and produced artifacts", () => {
    const { leadIn } = projectActiveContext(ctx);
    expect(leadIn).toContain('workflow run "MVT Landing Page"');
    expect(leadIn).toContain("run_7");
    expect(leadIn).toContain("workflow: mvt-landing-page");
    expect(leadIn).toContain("status: awaiting");
    expect(leadIn).toContain("company=Acme");
    expect(leadIn).toContain("art_a, art_b");
  });

  test("caps the step count and truncates each step output", () => {
    const { leadIn } = projectActiveContext(ctx);
    expect(leadIn).toContain(`step_${WORKFLOW_MAX_STEPS - 1}`);
    expect(leadIn).not.toContain(`step_${WORKFLOW_MAX_STEPS}`);
    expect(leadIn).toContain("more step(s)");
    expect(leadIn).not.toContain("STEP_TAIL");
  });
});

describe("thread projector", () => {
  const ctx: ThreadContext = {
    kind: "thread",
    id: "thr_1",
    label: "Pricing chat",
    turns: Array.from({ length: THREAD_MAX_TURNS + 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "agent",
      text: `${"t".repeat(THREAD_TURN_MAX_CHARS + 100)}TURN_TAIL_${i}`,
    })),
  };

  test("keeps only the most recent turns, truncated", () => {
    const { leadIn } = projectActiveContext(ctx);
    expect(leadIn).toContain('chat thread "Pricing chat"');
    // Exactly THREAD_MAX_TURNS turns survive — the oldest are dropped.
    const turnLines = leadIn
      .split("\n")
      .filter((l) => l.startsWith("User: ") || l.startsWith("Agent: "));
    expect(turnLines.length).toBe(THREAD_MAX_TURNS);
    // Every kept turn is truncated, so no full sentinel survives.
    expect(leadIn).not.toContain("TURN_TAIL_");
    expect(leadIn).toContain("…");
  });
});
