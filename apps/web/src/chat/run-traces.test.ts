import { describe, expect, test } from "bun:test";

import {
  emptyLiveTurn,
  foldRunStreamFrame,
  liveTurnVisible,
  tracesForMessages,
  type SavedInferenceTurn,
} from "./run-traces";
import type { WorkbenchMessage } from "./threads-api";

function message(
  id: string,
  author: "me" | "other",
  address: string,
  at: string,
  body = id,
): WorkbenchMessage {
  return {
    id,
    messageId: `<${id}@b.local>`,
    author,
    authorName: author === "me" ? "You" : "Worker",
    address,
    body,
    at,
    parentMessageId: undefined,
    attachments: [],
  };
}

describe("foldRunStreamFrame", () => {
  test("snapshot seeds status and in-progress text", () => {
    const turn = foldRunStreamFrame(emptyLiveTurn(), {
      type: "snapshot",
      status: "busy",
      text: "Working on ",
    });

    expect(turn.status).toBe("busy");
    expect(turn.text).toBe("Working on ");
    expect(turn.committed).toBe(false);
  });

  test("an idle snapshot after an in-flight turn marks it committed so a reconnect clears once mail lands", () => {
    const inFlight = [
      { type: "step.started" },
      { type: "text.delta", token: "Drafting reply" },
    ] as const;
    const partial = inFlight.reduce(foldRunStreamFrame, emptyLiveTurn());

    const reconnected = foldRunStreamFrame(partial, {
      type: "snapshot",
      status: "idle",
      text: "",
    });

    expect(reconnected.status).toBe("idle");
    expect(reconnected.committed).toBe(true);
    expect(reconnected.stepReasoningIndex).toBeNull();
  });

  test("accumulates reasoning, tool calls, tool results, and text in order across steps", () => {
    const frames = [
      { type: "step.started" },
      { type: "reasoning.delta", token: "First " },
      { type: "reasoning.delta", token: "plan." },
      { type: "tool.call", callId: "c1", name: "web_search", arguments: { q: "solana" } },
      { type: "step.done", reasoning: "First plan." },
      { type: "tool.result", callId: "c1", content: "hit", isError: false },
      { type: "step.started" },
      { type: "reasoning.delta", token: "Write reply." },
      { type: "text.delta", token: "Here is " },
      { type: "text.delta", token: "the brief." },
      { type: "turn.committed" },
    ] as const;

    const turn = frames.reduce(foldRunStreamFrame, emptyLiveTurn());

    expect(turn.status).toBe("idle");
    expect(turn.committed).toBe(true);
    expect(turn.text).toBe("Here is the brief.");
    expect(turn.parts).toEqual([
      { kind: "reasoning", text: "First plan." },
      {
        kind: "tool-trace",
        name: "web_search",
        input: { q: "solana" },
        output: "hit",
        status: "success",
      },
      { kind: "reasoning", text: "Write reply." },
    ]);
  });

  test("backfills reasoning from step.done when a provider sent no thinking deltas", () => {
    const frames = [
      { type: "step.started" },
      { type: "step.done", reasoning: "Provider-only summary." },
    ] as const;

    const turn = frames.reduce(foldRunStreamFrame, emptyLiveTurn());

    expect(turn.parts).toEqual([{ kind: "reasoning", text: "Provider-only summary." }]);
  });

  test("marks a failed tool result as an error trace", () => {
    const frames = [
      { type: "step.started" },
      { type: "tool.call", callId: "c1", name: "read_file", arguments: { path: "missing" } },
      { type: "tool.result", callId: "c1", content: "ENOENT", isError: true },
    ] as const;

    const turn = frames.reduce(foldRunStreamFrame, emptyLiveTurn());

    expect(turn.parts).toEqual([
      {
        kind: "tool-trace",
        name: "read_file",
        input: { path: "missing" },
        output: "ENOENT",
        status: "error",
      },
    ]);
  });

  test("a new step after a committed turn starts a fresh trace", () => {
    const frames = [
      { type: "step.started" },
      { type: "reasoning.delta", token: "Old." },
      { type: "text.delta", token: "Old reply." },
      { type: "turn.committed" },
    ] as const;
    const committed = frames.reduce(foldRunStreamFrame, emptyLiveTurn());

    const next = foldRunStreamFrame(committed, { type: "step.started" });

    expect(next.committed).toBe(false);
    expect(next.text).toBe("");
    expect(next.parts).toEqual([]);
  });
});

describe("liveTurnVisible", () => {
  const worker = "run_1@b.local";

  test("stays visible after turn.committed until the reply mail arrives", () => {
    const started = foldRunStreamFrame(emptyLiveTurn(1000), { type: "step.started" });
    const withText = foldRunStreamFrame(started, { type: "text.delta", token: "Answer" });
    const committed = foldRunStreamFrame(withText, { type: "turn.committed" });

    const beforeMail = [message("m1", "me", "alice@b.local", new Date(900).toISOString())];
    const afterMail = [
      ...beforeMail,
      message("m2", "other", worker, new Date(1300).toISOString(), "Answer"),
    ];

    expect(liveTurnVisible(committed, worker, beforeMail)).toBe(true);
    expect(liveTurnVisible(committed, worker, afterMail)).toBe(false);
  });

  test("hides an empty idle turn", () => {
    expect(liveTurnVisible(emptyLiveTurn(), worker, [])).toBe(false);
  });
});

describe("tracesForMessages", () => {
  const worker = "run_1@b.local";

  test("pairs each reply with the steps that ran before it and leaves any later steps unclaimed", () => {
    const messages = [
      message("m1", "me", "alice@b.local", "2026-10-19T06:00:00.000Z", "Hi"),
      message("m2", "other", worker, "2026-10-19T06:00:10.000Z", "Hello"),
      message("m3", "me", "alice@b.local", "2026-10-19T06:01:00.000Z", "Search Solana"),
      message("m4", "other", worker, "2026-10-19T06:01:20.000Z", "Found it"),
    ];
    const saved: SavedInferenceTurn[] = [
      {
        id: "t1",
        startedAt: "2026-10-19T06:00:02.000Z",
        endedAt: "2026-10-19T06:00:05.000Z",
        status: "completed",
        parts: [{ kind: "reasoning", text: "Greet Alice." }],
      },
      {
        id: "t2",
        startedAt: "2026-10-19T06:01:03.000Z",
        endedAt: "2026-10-19T06:01:08.000Z",
        status: "completed",
        parts: [
          { kind: "reasoning", text: "Run web search." },
          { kind: "tool-call", callId: "c1", name: "web_search", arguments: { q: "solana" } },
          { kind: "tool-result", callId: "c1", content: "ok", isError: false },
        ],
      },
      {
        id: "t3",
        startedAt: "2026-10-19T06:01:09.000Z",
        endedAt: "2026-10-19T06:01:15.000Z",
        status: "completed",
        parts: [{ kind: "reasoning", text: "Summarize." }],
      },
      {
        id: "t4",
        startedAt: "2026-10-19T06:02:00.000Z",
        endedAt: null,
        status: "running",
        parts: [{ kind: "tool-call", callId: "c2", name: "read_file", arguments: { path: "a" } }],
      },
    ];

    const matched = tracesForMessages(messages, [{ addresses: [worker], turns: saved }]);

    expect(matched.byMessageId.get("m1")).toBeUndefined();
    expect(matched.byMessageId.get("m2")).toEqual([{ kind: "reasoning", text: "Greet Alice." }]);
    expect(matched.byMessageId.get("m4")).toEqual([
      { kind: "reasoning", text: "Run web search." },
      {
        kind: "tool-trace",
        name: "web_search",
        input: { q: "solana" },
        output: "ok",
        status: "success",
      },
      { kind: "reasoning", text: "Summarize." },
    ]);
    expect(matched.inFlight.get(worker.toLowerCase())).toEqual([
      {
        kind: "tool-trace",
        name: "read_file",
        input: { path: "a" },
        status: "running",
      },
    ]);
  });
});
