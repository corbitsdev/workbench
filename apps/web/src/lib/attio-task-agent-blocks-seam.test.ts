import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildAttioTaskAgentBlocks } from "@workbench/workflow-attio-task-agent/blocks";
import {
  logRunStateSchema,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
} from "./run-state-adapter";

// CL-2731 real seam: drives a wire-shaped /state response through the production
// `logRunStateSchema` boundary parse, then the real `stepOutputsFromLog` +
// `runStateFromLog` decoders (exactly what WorkflowDock does), and only THEN into
// the attio-task-agent block builder. Nothing is hand-shaped past the wire.

function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

// A deterministic tool step stores its output as a `{ content: <json> }`
// envelope; an inference/agent step as `{ reply: <json> }`. The substrate then
// stores the whole envelope inline as `inline:<json-of-envelope>`.
const toolInline = (value: unknown): string =>
  `inline:${JSON.stringify({ content: JSON.stringify(value) })}`;
const replyInline = (value: unknown): string =>
  `inline:${JSON.stringify({ reply: JSON.stringify(value) })}`;

const MEMBERS = [
  {
    id: { workspace_member_id: "wm_1" },
    email_address: "sawyer@abklabs.com",
    first_name: "Sawyer",
    last_name: "",
  },
  { id: { workspace_member_id: "wm_2" }, email_address: "oat@abklabs.com" },
];

const TASKS = [
  {
    id: { task_id: "task_1" },
    content_plaintext: "Follow up with Acme on the pilot",
    deadline_at: "2026-07-10T00:00:00Z",
  },
  { id: { task_id: "task_2" }, content_plaintext: "Draft cold email to Beta" },
];

const CLARIFY_DECISION = {
  status: "need_clarification",
  reasoning: "I need to know which product line the pilot covers.",
  questions: ["Which product line?", "What's the target close date?"],
};

// Build a full run log with the given step overrides. Steps not overridden are
// completed with no output.
function buildLog(
  awaiting: { stepId: string; signal: string },
  overrides: Record<string, { outputRef?: string; phase?: string }> = {},
): LogRunState {
  const order = [
    "listMembers",
    "selectMember",
    "listTasks",
    "selectTask",
    "fetchTask",
    "analyze",
    "clarify",
    "review",
    "approveSync",
  ];
  const awaitingIndex = order.indexOf(awaiting.stepId);
  const steps = order.map((stepId, i) => {
    const override = overrides[stepId] ?? {};
    if (stepId === awaiting.stepId) {
      return {
        stepId,
        phase: "awaiting-signal" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        awaitingSignalName: awaiting.signal,
      };
    }
    const done = i < awaitingIndex;
    return {
      stepId,
      phase: (override.phase ?? (done ? "completed" : "in-flight")) as
        | "completed"
        | "in-flight",
      stepType: "deterministic" as const,
      currentAttempt: 1,
      ...(override.outputRef !== undefined
        ? { outputRef: override.outputRef }
        : {}),
    };
  });
  return parseLog({ runId: "run_attio", phase: "running", lastSeq: 9, steps });
}

function build(log: LogRunState) {
  const stepOutputs = stepOutputsFromLog(log);
  return buildAttioTaskAgentBlocks({
    runId: log.runId,
    phase: runStateFromLog(log).phase,
    steps: log.steps.map((step) => ({
      stepId: step.stepId,
      phase: step.phase,
      ...(step.awaitingSignalName !== undefined
        ? { awaitingSignalName: step.awaitingSignalName }
        : {}),
    })),
    stepOutputs,
  });
}

describe("attio-task-agent blocks — real log→state→blocks seam", () => {
  it("renders a member choice with human labels and an {assignee} payload", () => {
    const log = buildLog(
      { stepId: "selectMember", signal: "member-selection" },
      { listMembers: { outputRef: toolInline(MEMBERS), phase: "completed" } },
    );
    const blocks = build(log);

    expect(blocks.some((b) => b.kind === "progress")).toBe(true);

    const choice = blocks.find((b) => b.kind === "choice");
    expect(choice?.kind).toBe("choice");
    if (choice?.kind !== "choice") throw new Error("no choice");
    expect(choice.signalName).toBe("member-selection");
    expect(choice.options.length).toBe(2);
    // Human name is the headline; the email rides as secondary description.
    expect(choice.options[0]?.label).toBe("Sawyer");
    expect(choice.options[0]?.description).toBe("sawyer@abklabs.com");
    expect(choice.options[0]?.value).toBe("sawyer@abklabs.com");
    expect(choice.options[0]?.payload).toEqual({
      assignee: "sawyer@abklabs.com",
    });
    // A member with only an email has no separate secondary text.
    expect(choice.options[1]?.label).toBe("oat@abklabs.com");
    expect(choice.options[1]?.description).toBeUndefined();
  });

  it("renders a task choice with content headlines and a {taskId} payload", () => {
    const log = buildLog(
      { stepId: "selectTask", signal: "task-selection" },
      { listTasks: { outputRef: toolInline(TASKS), phase: "completed" } },
    );
    const choice = build(log).find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("no choice");
    expect(choice.signalName).toBe("task-selection");
    expect(choice.options[0]?.label).toBe("Follow up with Acme on the pilot");
    expect(choice.options[0]?.description).toBe("Due 2026-07-10");
    expect(choice.options[0]?.payload).toEqual({ taskId: "task_1" });
    expect(choice.options[1]?.description).toBeUndefined();
  });

  it("folds the clarification answer via a promptBox on a single continue option", () => {
    const log = buildLog(
      { stepId: "clarify", signal: "clarification" },
      {
        analyze: {
          outputRef: replyInline(CLARIFY_DECISION),
          phase: "completed",
        },
      },
    );
    const choice = build(log).find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("no choice");
    expect(choice.signalName).toBe("clarification");
    expect(choice.promptBox?.payloadKey).toBe("answers");
    expect(choice.prompt).toContain("Which product line?");
    expect(choice.options.length).toBe(1);
    // The option payload is an object so the host folds `answers` into it; an
    // empty continue resumes with `{}` (a valid best-effort proceed).
    expect(choice.options[0]?.payload).toEqual({});
    expect(choice.options[0]?.value).toBe("");
  });

  it("defers the review gate to a run-page link (no actionable choice)", () => {
    const blocks = build(buildLog({ stepId: "review", signal: "review" }));
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind).toBe("link");
    if (link?.kind === "link") expect(link.url).toBe("/workflows/run_attio");
  });

  it("defers the destructive sync-approval gate to a run-page link", () => {
    const blocks = build(
      buildLog({ stepId: "approveSync", signal: "sync-approval" }),
    );
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });

  it("sends the member gate to a run-page link when the completed producer's output is not resolvable", () => {
    // The producing step (listMembers) COMPLETED but its output is a blob
    // (> 1 MiB) ref that stepOutputsFromLog omits — there is nothing to choose
    // from AND nothing more is coming. It must be the documented run-page link,
    // never a perpetual "Loading…" text (which would strand the human forever).
    const log = buildLog(
      { stepId: "selectMember", signal: "member-selection" },
      { listMembers: { outputRef: "blob:sha256-abc", phase: "completed" } },
    );
    const blocks = build(log);
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "text")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") throw new Error("expected a run-page link");
    expect(link.url).toBe("/workflows/run_attio");
  });

  it("shows a transient Loading text while the member producer is still in-flight", () => {
    // listMembers is genuinely still running (no output yet) — the correct
    // affordance is the transient "Loading…" text, not a run-page link.
    const log = buildLog(
      { stepId: "selectMember", signal: "member-selection" },
      { listMembers: { phase: "in-flight" } },
    );
    const blocks = build(log);
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
    const text = blocks.find((b) => b.kind === "text");
    if (text?.kind !== "text") throw new Error("expected a loading text block");
    expect(text.text).toContain("Loading workspace members");
  });
});
