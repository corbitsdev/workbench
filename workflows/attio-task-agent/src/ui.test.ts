import { describe, expect, test } from "bun:test";
import type { RunState } from "@intx/workflow";
import {
  activeGate,
  defaultSelectedIndices,
  mergeReview,
  parseExecutorOutputs,
  parseReview,
  parseDecision,
  parseFirstLinkedRecord,
  parseMembers,
  parseTasks,
  peelOutput,
  type GeneratedArtifact,
} from "./ui";

// A deterministic tool step's output is a JSON envelope; an inference step's is
// a { reply } envelope. peelOutput must handle both plus bare objects.
function envelope(value: unknown) {
  return { content: JSON.stringify(value) };
}
function reply(value: unknown) {
  return { reply: JSON.stringify(value) };
}

function runStateAwaiting(stepId: string): RunState {
  return {
    steps: new Map([[stepId, { phase: "awaiting-signal" }]]),
  } as unknown as RunState;
}

describe("peelOutput", () => {
  test("peels a { content } JSON envelope", () => {
    expect(peelOutput(envelope([1, 2]))).toEqual([1, 2]);
  });
  test("peels a { reply } JSON envelope", () => {
    expect(peelOutput(reply({ a: 1 }))).toEqual({ a: 1 });
  });
  test("returns a bare object unchanged", () => {
    expect(peelOutput({ a: 1 })).toEqual({ a: 1 });
  });
  test("returns undefined for nullish", () => {
    expect(peelOutput(undefined)).toBeUndefined();
    expect(peelOutput(null)).toBeUndefined();
  });
  test("recovers JSON wrapped in a code fence", () => {
    expect(peelOutput({ reply: '```json\n{"a":1}\n```' })).toEqual({ a: 1 });
  });
  test("recovers JSON with a prose preamble", () => {
    expect(peelOutput({ reply: 'Here you go:\n{"a":1}' })).toEqual({ a: 1 });
  });
});

describe("activeGate", () => {
  test("returns the awaiting gate", () => {
    expect(activeGate(runStateAwaiting("clarify"))).toBe("clarify");
    expect(activeGate(runStateAwaiting("approveSync"))).toBe("approveSync");
  });
  test("returns null when no gate is awaiting", () => {
    expect(activeGate(null)).toBeNull();
    expect(activeGate(runStateAwaiting("analyze"))).toBeNull();
  });
});

describe("parseMembers", () => {
  test("maps members to assignee + label, preferring name then email", () => {
    const raw = envelope([
      {
        id: { workspace_member_id: "wm_1" },
        email_address: "sawyer@abklabs.com",
        first_name: "Sawyer",
        last_name: "Cutler",
      },
      { id: { workspace_member_id: "wm_2" }, email: "p@abklabs.com" },
    ]);
    expect(parseMembers(raw)).toEqual({
      status: "ok",
      value: [
        { assignee: "sawyer@abklabs.com", label: "Sawyer Cutler" },
        { assignee: "p@abklabs.com", label: "p@abklabs.com" },
      ],
    });
  });
  test("pending when the step has produced no output yet", () => {
    expect(parseMembers(undefined)).toEqual({ status: "pending" });
  });
  test("malformed for a present-but-unparseable payload", () => {
    expect(parseMembers(envelope({ nope: true }))).toEqual({
      status: "malformed",
    });
  });
  test("distinguishes a genuinely empty list from malformed", () => {
    expect(parseMembers(envelope([]))).toEqual({ status: "ok", value: [] });
  });
});

describe("parseTasks", () => {
  test("maps tasks to taskId + label + deadline", () => {
    const raw = envelope([
      {
        id: { task_id: "task_1" },
        content_plaintext: "Follow up",
        deadline_at: "2026-07-10T00:00:00Z",
      },
    ]);
    expect(parseTasks(raw)).toEqual({
      status: "ok",
      value: [
        {
          taskId: "task_1",
          label: "Follow up",
          deadline: "2026-07-10T00:00:00Z",
        },
      ],
    });
  });
  test("falls back to task id when content is empty", () => {
    expect(parseTasks(envelope([{ id: { task_id: "t2" } }]))).toEqual({
      status: "ok",
      value: [{ taskId: "t2", label: "t2" }],
    });
  });
  test("pending vs malformed vs empty are distinct", () => {
    expect(parseTasks(undefined)).toEqual({ status: "pending" });
    expect(parseTasks(envelope({ nope: true }))).toEqual({
      status: "malformed",
    });
    expect(parseTasks(envelope([]))).toEqual({ status: "ok", value: [] });
  });
});

describe("parseDecision", () => {
  test("parses a decision with questions", () => {
    const d = parseDecision(
      reply({ status: "need_clarification", questions: ["Which region?"] }),
    );
    expect(d.status).toBe("ok");
    if (d.status !== "ok") throw new Error("expected ok");
    expect(d.value.status).toBe("need_clarification");
    expect(d.value.questions).toEqual(["Which region?"]);
  });
  test("pending when no output yet", () => {
    expect(parseDecision(undefined)).toEqual({ status: "pending" });
  });
  test("malformed for garbage that is present", () => {
    expect(parseDecision("not json")).toEqual({ status: "malformed" });
  });
});

describe("parseExecutorOutputs", () => {
  test("returns the executor's produced outputs from a single { outputs } reply", () => {
    const raw = reply({
      outputs: [
        { type: "cold-email", title: "Outreach", content: "Hi", brief: "b" },
        { type: "blog", title: "Post", content: "Body" },
      ],
    });
    const got = parseExecutorOutputs(raw);
    expect(got.status).toBe("ok");
    if (got.status !== "ok") throw new Error("expected ok");
    expect(got.value.length).toBe(2);
    expect(got.value[0]).toMatchObject({
      type: "cold-email",
      title: "Outreach",
    });
  });

  test("pending when the executor step has not landed yet", () => {
    expect(parseExecutorOutputs(undefined)).toEqual({ status: "pending" });
  });

  test("an empty plan result is ok (not malformed) — the plan needed no drafts", () => {
    expect(parseExecutorOutputs(reply({ outputs: [] }))).toEqual({
      status: "ok",
      value: [],
    });
  });

  test("malformed when the output is present but not an { outputs } shape", () => {
    expect(parseExecutorOutputs(reply({ oops: true }))).toEqual({
      status: "malformed",
    });
  });

  test("a fenced executor reply still yields the outputs", () => {
    const got = parseExecutorOutputs({
      reply:
        '```json\n{"outputs":[{"type":"blog","title":"P","content":"B"}]}\n```',
    });
    expect(got.status).toBe("ok");
    if (got.status !== "ok") throw new Error("expected ok");
    expect(got.value).toEqual([{ type: "blog", title: "P", content: "B" }]);
  });
});

describe("parseReview", () => {
  test("parses the reviewer's per-output verdicts", () => {
    const raw = reply({
      overall: "Both send-ready.",
      items: [
        { type: "cold-email", verdict: "pass", notes: "Good." },
        { type: "blog", verdict: "revise", notes: "Tighten the intro." },
      ],
    });
    const got = parseReview(raw);
    expect(got.status).toBe("ok");
    if (got.status !== "ok") throw new Error("expected ok");
    expect(got.value.items.find((i) => i.type === "blog")?.verdict).toBe(
      "revise",
    );
  });

  test("pending when no review yet; malformed for garbage", () => {
    expect(parseReview(undefined)).toEqual({ status: "pending" });
    expect(parseReview(reply({ overall: 1 }))).toEqual({ status: "malformed" });
  });
});

describe("parseDecision (planner envelope → structured plan)", () => {
  test("recovers draftActions from a reply-enveloped, JSON-stringified decision", () => {
    // The real planner output on a live sidecar: {reply:"<json string>"} — the
    // parser must unwrap AND parse to reach the plan (regression guard for the
    // envelope surface the runLocal test mocks away).
    const d = parseDecision(
      reply({
        status: "ready",
        reasoning: "ok",
        draftActions: [
          { type: "cold-email", brief: "Draft outreach." },
          { type: "cold-email", brief: "Draft a warmer variant." },
        ],
      }),
    );
    expect(d.status).toBe("ok");
    if (d.status !== "ok") throw new Error("expected ok");
    expect(d.value.draftActions?.length).toBe(2);
  });
});

describe("mergeReview (verdict join)", () => {
  const drafts: GeneratedArtifact[] = [
    { type: "cold-email", title: "A", content: "a" },
    { type: "cold-email", title: "B", content: "b" }, // SAME type as the first
    { type: "blog", title: "C", content: "c" },
  ];

  test("joins verdicts BY INDEX, not by type — duplicate types don't misattribute", () => {
    const review = {
      overall: "x",
      items: [
        { type: "cold-email", verdict: "pass" as const, notes: "first" },
        { type: "cold-email", verdict: "reject" as const, notes: "second" },
        { type: "blog", verdict: "revise" as const, notes: "third" },
      ],
    };
    const merged = mergeReview(drafts, review);
    // The two same-type drafts get DIFFERENT verdicts (a type-join would give
    // both the first cold-email's "pass").
    expect(merged[0]).toMatchObject({ verdict: "pass", notes: "first" });
    expect(merged[1]).toMatchObject({ verdict: "reject", notes: "second" });
    expect(merged[2]).toMatchObject({ verdict: "revise", notes: "third" });
  });

  test("leaves drafts unjudged when the review is absent or shorter", () => {
    expect(
      mergeReview(drafts, null).every((r) => r.verdict === undefined),
    ).toBe(true);
    const short = {
      overall: "x",
      items: [{ type: "cold-email", verdict: "pass" as const, notes: "" }],
    };
    const merged = mergeReview(drafts, short);
    expect(merged[0]?.verdict).toBe("pass");
    expect(merged[1]?.verdict).toBeUndefined();
  });
});

describe("defaultSelectedIndices (safe default)", () => {
  const drafts: GeneratedArtifact[] = [
    { type: "cold-email", title: "A", content: "a" },
    { type: "blog", title: "B", content: "b" },
    { type: "twitter-post", title: "C", content: "c" },
  ];

  test("with a review, pre-selects ONLY passed drafts (revise/reject opted-in, not out)", () => {
    const review = {
      overall: "x",
      items: [
        { type: "cold-email", verdict: "pass" as const, notes: "" },
        { type: "blog", verdict: "revise" as const, notes: "" },
        { type: "twitter-post", verdict: "reject" as const, notes: "" },
      ],
    };
    const sel = defaultSelectedIndices(mergeReview(drafts, review), true);
    expect([...sel]).toEqual([0]);
  });

  test("with no review yet, pre-selects everything (no signal to withhold)", () => {
    const sel = defaultSelectedIndices(mergeReview(drafts, null), false);
    expect(sel.size).toBe(3);
  });
});

describe("parseFirstLinkedRecord", () => {
  test("returns the first linked record", () => {
    const raw = envelope({
      task: {},
      linkedRecords: [
        { object: "companies", recordId: "rec_1" },
        { object: "people", recordId: "rec_2" },
      ],
    });
    expect(parseFirstLinkedRecord(raw)).toEqual({
      status: "ok",
      value: { object: "companies", recordId: "rec_1" },
    });
  });
  test("ok with null when there are no linked records", () => {
    expect(parseFirstLinkedRecord(envelope({ task: {} }))).toEqual({
      status: "ok",
      value: null,
    });
  });
  test("pending vs malformed are distinct from empty", () => {
    expect(parseFirstLinkedRecord(undefined)).toEqual({ status: "pending" });
    expect(parseFirstLinkedRecord(envelope("nope"))).toEqual({
      status: "malformed",
    });
  });
});
