import { describe, expect, it } from "bun:test";
import type { InstanceEvent } from "@intx/hub-client";
import { composeChatMessages } from "./chat-messages";

/**
 * Transport-shape-agnostic regression spec for the event -> message
 * composition layer (composeChatMessages + convertInstanceEvents), pinned
 * ahead of the parts-based assembler migration.
 *
 * Every scenario here reproduces the ORIGINAL failure documented in the
 * CL-tagged comments on chat-messages.ts. A parts-based assembler that
 * replaces the current flat-message model must reproduce the same
 * user-observable outcomes asserted below (one rendered message per
 * assistant reply, stable ids/feedback subjects, stable ordering, and
 * correct segment sequencing) even though its internal representation will
 * differ.
 */

const userMail = (
  id: string,
  content: string,
  timestamp: string,
): InstanceEvent => ({
  kind: "mail",
  id,
  role: "user",
  content,
  sender: { name: null, email: "u@example.com" },
  recipients: [],
  timestamp,
  attachments: [],
});

const assistantMail = (
  id: string,
  content: string,
  timestamp: string,
): InstanceEvent => ({
  kind: "mail",
  id,
  role: "assistant",
  content,
  sender: { name: "Agent", email: "a@example.com" },
  recipients: [],
  timestamp,
  attachments: [],
});

const textTurn = (
  turnId: string,
  content: string,
  timestamp: string,
  extra: Partial<InstanceEvent> = {},
): InstanceEvent => ({
  kind: "turn",
  turnId,
  content,
  timestamp,
  ...extra,
});

describe("composition regression spec: turn/mail dedup and hoisting", () => {
  it("renders exactly one message when an assistant reply arrives as both a committed turn and mail", () => {
    // The same logical reply is delivered twice by the transport: once as a
    // client-clock turn (rendered live before commit) and once as the
    // server-clock mail that echoes it. The composed thread must never show
    // two bubbles for one reply.
    const turn = textTurn(
      "t1",
      "The answer is 42.",
      "2024-01-01T00:00:40.000Z",
    );
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "what is the answer?", "2024-01-01T00:00:00.000Z"),
        turn,
        assistantMail("a1", "The answer is 42.", "2024-01-01T00:00:30.000Z"),
      ],
      streaming: "",
    });

    const replies = messages.filter(
      (m) => m.role === "agent" && m.content === "The answer is 42.",
    );
    expect(replies).toHaveLength(1);
  });

  it("keeps the tool-call turn, not the echoing assistant mail, when a reply carries tool calls", () => {
    // Mail cannot represent tool calls, so when a tool-carrying turn and a
    // content-identical mail both exist, the turn must win.
    const turn = textTurn(
      "t1",
      "Searched and found it.",
      "2024-01-01T00:00:30.000Z",
      {
        toolCalls: [
          {
            name: "exa_search",
            arguments: { query: "x" },
            result: "r",
            isError: false,
          },
        ],
      },
    );
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "find it", "2024-01-01T00:00:00.000Z"),
        turn,
        assistantMail(
          "a1",
          "Searched and found it.",
          "2024-01-01T00:00:45.000Z",
        ),
      ],
      streaming: "",
    });

    const replies = messages.filter(
      (m) => m.role === "agent" && m.content === "Searched and found it.",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe("t1");
    expect(replies[0]?.toolCalls?.[0]?.name).toBe("exa_search");
  });

  it("does not collapse two distinct replies that happen to share identical text", () => {
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "do a", "2024-01-01T00:00:00.000Z"),
        assistantMail("a1", "Done.", "2024-01-01T00:00:10.000Z"),
        userMail("u2", "do b", "2024-01-01T00:00:20.000Z"),
        assistantMail("a2", "Done.", "2024-01-01T00:00:30.000Z"),
      ],
      streaming: "",
    });

    const replies = messages.filter((m) => m.content === "Done.");
    expect(replies.map((m) => m.id)).toEqual(["a1", "a2"]);
  });
});

describe("composition regression spec: feedback-id pinning across the turn -> mail flip", () => {
  it("keeps the feedback subject pinned to the original turn id once the mail replaces the turn's display id", () => {
    // A rating saved while the reply was still a live turn is keyed to the
    // turnId. When the mail lands and the bubble's display id flips to the
    // mailId, the feedback subject must stay the turnId or the saved rating
    // becomes orphaned.
    const turn = textTurn("t1", "Same content", "2024-01-01T00:00:30.000Z");

    const beforeMail = composeChatMessages({
      events: [userMail("u1", "hi", "2024-01-01T00:00:00.000Z"), turn],
      streaming: "",
    });
    const liveBubble = beforeMail.messages.find(
      (m) => m.content === "Same content",
    );
    const originalSubjectId = liveBubble?.feedbackId ?? liveBubble?.id;
    expect(originalSubjectId).toBe("t1");

    const afterMail = composeChatMessages({
      events: [
        userMail("u1", "hi", "2024-01-01T00:00:00.000Z"),
        turn,
        assistantMail("a1", "Same content", "2024-01-01T00:00:45.000Z"),
      ],
      streaming: "",
    });
    const settledBubble = afterMail.messages.find(
      (m) => m.content === "Same content",
    );

    expect(settledBubble?.id).toBe("a1");
    expect(settledBubble?.feedbackId).toBe(originalSubjectId);
  });

  it("carries no feedback override when a turn never collapses into a mail (no id flip occurs)", () => {
    const toolTurn = textTurn(
      "t1",
      "Done searching",
      "2024-01-01T00:00:30.000Z",
      {
        toolCalls: [
          { name: "exa_search", arguments: {}, result: "r", isError: false },
        ],
      },
    );
    const { messages } = composeChatMessages({
      events: [userMail("u1", "search", "2024-01-01T00:00:00.000Z"), toolTurn],
      streaming: "",
    });
    const reply = messages.find((m) => m.content === "Done searching");
    expect(reply?.id).toBe("t1");
    expect(reply?.feedbackId).toBeUndefined();
  });
});

describe("composition regression spec: ordering stability under mixed clocks", () => {
  it("keeps the newer user message below the prior response regardless of turn timestamps (ordering is array-order, not clock-sorted)", () => {
    // The turn's client clock runs ahead of the mail's server clock. Because
    // the turn is dropped in favour of the mail (server-anchored), the
    // subsequent user message stays below the reply.
    const turn = textTurn("t1", "first answer", "2024-01-01T00:09:00.000Z");
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "first", "2024-01-01T00:00:00.000Z"),
        turn,
        assistantMail("a1", "first answer", "2024-01-01T00:00:30.000Z"),
        userMail("u2", "second", "2024-01-01T00:01:00.000Z"),
      ],
      streaming: "",
    });
    expect(messages.map((m) => m.content)).toEqual([
      "first",
      "first answer",
      "second",
    ]);
  });

  it("anchors a late-arriving assistant mail to the dropped turn's earlier slot, not its own tail arrival position", () => {
    const turn = textTurn("t1", "first answer", "2024-01-01T00:00:30.000Z");
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "first", "2024-01-01T00:00:00.000Z"),
        turn,
        userMail("u2", "second", "2024-01-01T00:01:00.000Z"),
        // Mail for the FIRST reply arrives late, appended after u2.
        assistantMail("a1", "first answer", "2024-01-01T00:00:45.000Z"),
      ],
      streaming: "",
    });
    expect(messages.map((m) => m.content)).toEqual([
      "first",
      "first answer",
      "second",
    ]);
    expect(messages.find((m) => m.content === "first answer")?.id).toBe("a1");
  });
});

describe("composition regression spec: empty-text committed turns", () => {
  it("overwrites an empty committed trailing bubble with the still-live streamed text", () => {
    const emptyTurn = textTurn("t1", "", "2024-01-01T00:00:30.000Z");
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi", "2024-01-01T00:00:00.000Z"), emptyTurn],
      streaming: "Here is my answer",
    });
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("agent");
    expect(last?.content).toBe("Here is my answer");
    expect(last?.status).toBe("sending");
    // Exactly one agent bubble exists — the empty commit was overwritten,
    // not left behind as a second, empty message.
    expect(messages.filter((m) => m.role === "agent")).toHaveLength(1);
  });

  it("leaves a non-empty committed bubble alone and streams the next segment as its own bubble", () => {
    const committedSegment = textTurn(
      "t1",
      "Let me search for that.",
      "2024-01-01T00:00:30.000Z",
      {
        toolCalls: [
          {
            name: "exa_search",
            arguments: { query: "x" },
            result: "r",
            isError: false,
          },
        ],
      },
    );
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "find x", "2024-01-01T00:00:00.000Z"),
        committedSegment,
      ],
      streaming: "Here is what I found",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[0]?.content).toBe("Let me search for that.");
    expect(agentMessages[0]?.status).not.toBe("sending");
    expect(agentMessages[1]?.content).toBe("Here is what I found");
    expect(agentMessages[1]?.status).toBe("sending");
  });
});

describe("composition regression spec: cross-turn streaming-buffer bleed", () => {
  it("does not merge the new turn's live text into a prior, already-committed non-empty bubble", () => {
    // If the streaming buffer accumulated across turns instead of resetting
    // per-turn, this live text would paint over (or append to) the prior
    // committed reply. It must instead form its own trailing bubble.
    const firstReply = textTurn(
      "t1",
      "First segment done.",
      "2024-01-01T00:00:30.000Z",
    );
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go", "2024-01-01T00:00:00.000Z"),
        firstReply,
        userMail("u2", "continue", "2024-01-01T00:01:00.000Z"),
      ],
      streaming: "Second segment in progress",
    });

    const firstBubble = messages.find(
      (m) => m.content === "First segment done.",
    );
    expect(firstBubble?.status).not.toBe("sending");

    const streamingBubble = messages[messages.length - 1];
    expect(streamingBubble?.content).toBe("Second segment in progress");
    expect(streamingBubble?.status).toBe("sending");
    expect(streamingBubble?.id).not.toBe(firstBubble?.id);
  });

  it("does not carry live reasoning from a prior turn onto the new turn's streaming bubble", () => {
    // Reasoning is turn-scoped exactly like the text buffer. A prior turn's
    // reasoning must never appear attached to the CURRENT turn's synthetic
    // bubble — only the reasoning value the caller passes in for the turn
    // presently streaming.
    const firstReply = textTurn(
      "t1",
      "First segment done.",
      "2024-01-01T00:00:30.000Z",
      { reasoning: "Reasoning for the first segment." },
    );
    const { messages } = composeChatMessages({
      events: [userMail("u1", "go", "2024-01-01T00:00:00.000Z"), firstReply],
      streaming: "Second segment in progress",
      reasoning: "",
    });

    const streamingBubble = messages[messages.length - 1];
    expect(streamingBubble?.content).toBe("Second segment in progress");
    expect(streamingBubble?.reasoning).toBeUndefined();
  });
});

describe("composition regression spec: multi-segment part ordering (text -> tool -> reasoning -> text)", () => {
  it("preserves event-arrival order across a multi-segment reply's committed bubbles", () => {
    // A single logical exchange spans multiple committed turns: a lead-in
    // text segment, a tool-carrying segment, a reasoning-bearing segment, and
    // a closing text segment. The composed message array is the boundary a
    // future parts-based assembler must also honour — message N's content
    // must reflect segment N regardless of internal representation.
    const leadIn = textTurn(
      "t1",
      "Let me look into that.",
      "2024-01-01T00:00:10.000Z",
    );
    const toolSegment = textTurn(
      "t2",
      "Checked the records.",
      "2024-01-01T00:00:20.000Z",
      {
        toolCalls: [
          {
            name: "crm_lookup",
            arguments: { id: "123" },
            result: "found",
            isError: false,
          },
        ],
      },
    );
    const reasoningSegment = textTurn(
      "t3",
      "Cross-referencing with the notes.",
      "2024-01-01T00:00:30.000Z",
      { reasoning: "The record conflicts with the call notes; reconciling." },
    );
    const closing = textTurn(
      "t4",
      "Here is the summary.",
      "2024-01-01T00:00:40.000Z",
    );

    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "look into the account", "2024-01-01T00:00:00.000Z"),
        leadIn,
        toolSegment,
        reasoningSegment,
        closing,
      ],
      streaming: "",
    });

    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages.map((m) => m.content)).toEqual([
      "Let me look into that.",
      "Checked the records.",
      "Cross-referencing with the notes.",
      "Here is the summary.",
    ]);
    expect(agentMessages[1]?.toolCalls?.[0]?.name).toBe("crm_lookup");
    // Reloaded turns no longer carry a reasoning trace (upstream dropped it
    // from the hub-client `InstanceEvent` turn variant); segment ORDER is still
    // preserved, which is what this regression spec guards.
    expect(agentMessages[2]?.reasoning).toBeUndefined();
    expect(agentMessages[0]?.toolCalls).toBeUndefined();
    expect(agentMessages[3]?.toolCalls).toBeUndefined();
  });

  it("preserves call order within a single turn's tool-call array", () => {
    const turn = textTurn(
      "t1",
      "Ran two lookups.",
      "2024-01-01T00:00:10.000Z",
      {
        toolCalls: [
          {
            name: "crm_lookup",
            arguments: { id: "1" },
            result: "a",
            isError: false,
          },
          {
            name: "calendar_lookup",
            arguments: { id: "2" },
            result: "b",
            isError: false,
          },
        ],
      },
    );
    const { messages } = composeChatMessages({
      events: [userMail("u1", "check both", "2024-01-01T00:00:00.000Z"), turn],
      streaming: "",
    });
    const reply = messages.find((m) => m.content === "Ran two lookups.");
    expect(reply?.toolCalls?.map((tc) => tc.name)).toEqual([
      "crm_lookup",
      "calendar_lookup",
    ]);
  });

  it("appends the live tool/reasoning/text segment after prior committed segments, completing the sequence", () => {
    // The tail of the same multi-segment exchange, still in progress: three
    // segments have already committed (text, tool, reasoning-bearing text)
    // and the final text segment is still streaming live. The live bubble
    // must land strictly after the three committed ones.
    const leadIn = textTurn(
      "t1",
      "Let me look into that.",
      "2024-01-01T00:00:10.000Z",
    );
    const toolSegment = textTurn(
      "t2",
      "Checked the records.",
      "2024-01-01T00:00:20.000Z",
      {
        toolCalls: [
          {
            name: "crm_lookup",
            arguments: { id: "123" },
            result: "found",
            isError: false,
          },
        ],
      },
    );
    const reasoningSegment = textTurn(
      "t3",
      "Cross-referencing with the notes.",
      "2024-01-01T00:00:30.000Z",
      { reasoning: "The record conflicts with the call notes; reconciling." },
    );

    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "look into the account", "2024-01-01T00:00:00.000Z"),
        leadIn,
        toolSegment,
        reasoningSegment,
      ],
      streaming: "Here is the summary",
    });

    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(4);
    expect(agentMessages.map((m) => m.content)).toEqual([
      "Let me look into that.",
      "Checked the records.",
      "Cross-referencing with the notes.",
      "Here is the summary",
    ]);
    expect(agentMessages[3]?.status).toBe("sending");
  });
});
