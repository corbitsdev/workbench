import { describe, expect, it } from "bun:test";
import type { InstanceEvent } from "@intx/hub-client";
import { composeChatMessages, STREAMING_BUBBLE_ID } from "./chat-messages";

const userMail = (
  id: string,
  content: string,
  timestamp = "2024-01-01T00:00:00.000Z",
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
  timestamp = "2024-01-01T00:01:00.000Z",
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

describe("composeChatMessages", () => {
  it("synthesizes a reasoning-only streaming bubble while thinking (no answer yet)", () => {
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi")],
      streaming: "",
      reasoning: "Let me check the calls",
    });
    const last = messages[messages.length - 1];
    expect(last?.id).toBe(STREAMING_BUBBLE_ID);
    expect(last?.role).toBe("agent");
    expect(last?.content).toBe("");
    expect(last?.reasoning).toBe("Let me check the calls");
    expect(last?.status).toBe("sending");
  });

  it("attaches live reasoning to the streaming answer bubble", () => {
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi")],
      streaming: "Here is the answer",
      reasoning: "Reasoned about it",
    });
    const last = messages[messages.length - 1];
    expect(last?.content).toBe("Here is the answer");
    expect(last?.reasoning).toBe("Reasoned about it");
  });

  it("synthesizes a streaming bubble while streaming with no durable reply yet", () => {
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi")],
      streaming: "Thinking out lou",
    });
    const last = messages[messages.length - 1];
    expect(last?.id).toBe(STREAMING_BUBBLE_ID);
    expect(last?.content).toBe("Thinking out lou");
    expect(last?.status).toBe("sending");
  });

  it("overwrites the trailing assistant bubble with the live streaming buffer", () => {
    // turn.committed landed empty (CL-1398) but the streamed text is still live.
    const emptyTurn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "",
      timestamp: "2024-01-01T00:00:30.000Z",
    };
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi"), emptyTurn],
      streaming: "Here is my answer",
    });
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("agent");
    expect(last?.content).toBe("Here is my answer");
    expect(last?.status).toBe("sending");
  });

  it("does not overwrite a non-empty committed bubble — the next segment streams as its own bubble", () => {
    // Multi-step tool-loop reply: an earlier text segment commits as its own
    // (non-empty) bubble, then the next segment's text streams live. Overwriting
    // the committed segment would transiently mask it (CL-1643). The live text
    // belongs to a not-yet-committed turn, so it must form a new bubble.
    const committedSegment: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Let me search for that.",
      timestamp: "2024-01-01T00:00:30.000Z",
      toolCalls: [
        {
          name: "exa_search",
          arguments: { query: "x" },
          result: "r",
          isError: false,
        },
      ],
    };
    const { messages } = composeChatMessages({
      events: [userMail("u1", "find x"), committedSegment],
      streaming: "Here is what I found",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[0]?.content).toBe("Let me search for that.");
    expect(agentMessages[1]?.content).toBe("Here is what I found");
    expect(agentMessages[1]?.status).toBe("sending");
  });

  it("suppresses a duplicate streaming bubble when the final segment already committed the same text (CL-3948)", () => {
    // The final segment commits its text ("Got it. Let me log this...") while
    // the live streaming buffer still holds that same text — the turn is parked
    // on a native approval gate and never reset the buffer. Synthesizing a
    // STREAMING_BUBBLE_ID bubble here would render the final line twice; the
    // id-dedupe can't catch it (the committed bubble carries its own id).
    const committed: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Got it. Let me log this as an issue in Linear.",
      timestamp: "2024-01-01T00:00:30.000Z",
    };
    const { messages } = composeChatMessages({
      events: [userMail("u1", "log a bug"), committed],
      streaming: "Got it. Let me log this as an issue in Linear.",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.content).toBe(
      "Got it. Let me log this as an issue in Linear.",
    );
    expect(messages.some((m) => m.id === STREAMING_BUBBLE_ID)).toBe(false);
  });

  it("still streams a genuinely different continuation as its own bubble (no over-suppression, CL-3948)", () => {
    const committed: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Let me search for that.",
      timestamp: "2024-01-01T00:00:30.000Z",
    };
    const { messages } = composeChatMessages({
      events: [userMail("u1", "find x"), committed],
      streaming: "Here is what I found.",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[1]?.id).toBe(STREAMING_BUBBLE_ID);
    expect(agentMessages[1]?.content).toBe("Here is what I found.");
  });

  it("shows no streaming bubble once the durable reply has landed and streaming cleared", () => {
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi"), assistantMail("a1", "Real answer")],
      streaming: "",
    });
    expect(messages.some((m) => m.id === "streaming-synthetic")).toBe(false);
    expect(messages[messages.length - 1]?.content).toBe("Real answer");
  });

  it("keeps the server-timestamped mail and drops the echoing text-only turn", () => {
    // A text reply exists as both a client-clock turn and a server-clock mail.
    // The mail must win so ordering stays anchored to the server clock.
    const turn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Same content",
      // Client clock ahead — later than the mail's server timestamp.
      timestamp: "2024-01-01T00:09:00.000Z",
    };
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "hi", "2024-01-01T00:00:00.000Z"),
        turn,
        assistantMail("a1", "Same content", "2024-01-01T00:00:30.000Z"),
      ],
      streaming: "",
    });
    const agentMessages = messages.filter(
      (m) => m.role === "agent" && m.content === "Same content",
    );
    expect(agentMessages).toHaveLength(1);
    // The surviving message is the mail (server timestamp), not the turn.
    expect(agentMessages[0]?.id).toBe("a1");
  });

  it("orders the last sent message below the prior response despite a skewed turn clock", () => {
    // Reproduces the live bug: the prior reply's turn carries a client clock that
    // runs ahead of the next user mail's server timestamp. Because the text turn
    // is dropped in favour of the server-timestamped mail, the new user message
    // stays below the response after sorting.
    const turn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "first answer",
      timestamp: "2024-01-01T00:09:00.000Z", // skewed-ahead client clock
    };
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

  it("anchors a late-arriving assistant mail to the dropped turn position, below no newer message", () => {
    // The live bug (CL-1788): in a static, non-streaming chat the prior reply
    // exists as a text-only turn. The user sends a new message, and only THEN
    // does the assistant mail echoing the prior reply arrive via SSE — appended
    // at the tail, after the new user mail. The dedup drops the text-only turn
    // in favour of the mail; if the mail keeps its late tail position the prior
    // reply jumps BELOW the just-sent message. The surviving mail must take the
    // dropped turn's (earlier) slot instead.
    const turn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "first answer",
      timestamp: "2024-01-01T00:00:30.000Z",
    };
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "first", "2024-01-01T00:00:00.000Z"),
        turn,
        userMail("u2", "second", "2024-01-01T00:01:00.000Z"),
        // Assistant mail for the FIRST reply, delivered late — after u2.
        assistantMail("a1", "first answer", "2024-01-01T00:00:45.000Z"),
      ],
      streaming: "",
    });
    expect(messages.map((m) => m.content)).toEqual([
      "first",
      "first answer",
      "second",
    ]);
    const answer = messages.find((m) => m.content === "first answer");
    expect(answer?.id).toBe("a1");
  });

  it("keeps two distinct assistant replies that share identical text", () => {
    // Hoisting must match by id, not content: two separate replies that happen
    // to carry the same text (e.g. "Done.") are distinct messages and must not
    // be collapsed into one.
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "do a", "2024-01-01T00:00:00.000Z"),
        assistantMail("a1", "Done.", "2024-01-01T00:00:10.000Z"),
        userMail("u2", "do b", "2024-01-01T00:00:20.000Z"),
        assistantMail("a2", "Done.", "2024-01-01T00:00:30.000Z"),
      ],
      streaming: "",
    });
    const replies = messages.filter(
      (m) => m.role === "agent" && m.content === "Done.",
    );
    expect(replies).toHaveLength(2);
    expect(replies.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("deduplicates events with the same id (hydration-race guard)", () => {
    // The session hydrates via a REST fetch, then drains the SSE buffer. If the
    // same mail arrives in both, convertInstanceEvents emits it twice with the
    // same id. The id-based pass must keep only the first.
    const mail = assistantMail("a1", "Hello");
    const { messages } = composeChatMessages({
      events: [userMail("u1", "hi"), mail, { ...mail }],
      streaming: "",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.id).toBe("a1");
  });

  it("keeps a stable feedback id across the turn→mail collapse so a saved rating survives", () => {
    // A text-only reply is first rendered live as a turn (its echoing assistant
    // mail has not arrived yet), so the bubble id — and the rating subjectId the
    // user saves under — is the turnId. Once the mail lands, the turn is dropped
    // and the surviving bubble's display id becomes the mail id. If feedback were
    // keyed on the display id, getRating(mailId) would miss the rating stored
    // under turnId and the thumb would revert. feedbackId must stay the turnId.
    const turn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Same content",
      timestamp: "2024-01-01T00:00:30.000Z",
    };

    const liveOnly = composeChatMessages({
      events: [userMail("u1", "hi", "2024-01-01T00:00:00.000Z"), turn],
      streaming: "",
    });
    const liveBubble = liveOnly.messages.find(
      (m) => m.content === "Same content",
    );
    const savedSubjectId = liveBubble?.feedbackId ?? liveBubble?.id;
    expect(savedSubjectId).toBe("t1");

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
    // Display id flips to the durable mail id, but the feedback subject must not.
    expect(settledBubble?.id).toBe("a1");
    expect(settledBubble?.feedbackId ?? settledBubble?.id).toBe(savedSubjectId);
  });

  it("collapses a text-only turn with its assistant mail despite whitespace drift", () => {
    const turn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Just one new record yesterday:\n\nCompany: Leland",
      timestamp: "2024-01-01T00:00:30.000Z",
    };

    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "what changed yesterday?"),
        turn,
        assistantMail(
          "a1",
          "Just one new record yesterday:\n\n\nCompany: Leland",
        ),
      ],
      streaming: "",
    });

    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.id).toBe("a1");
    expect(agentMessages[0]?.feedbackId).toBe("t1");
  });

  it("keeps a tool-call turn and drops the assistant mail that echoes it", () => {
    const toolTurn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Done searching",
      timestamp: "2024-01-01T00:00:30.000Z",
      toolCalls: [
        {
          name: "exa_search",
          arguments: { query: "x" },
          result: "r",
          isError: false,
        },
      ],
    };
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "search"),
        toolTurn,
        assistantMail("a1", "Done searching"),
      ],
      streaming: "",
    });
    const agentMessages = messages.filter((m) => m.role === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]?.id).toBe("t1");
    expect(agentMessages[0]?.toolCalls?.[0]?.name).toBe("exa_search");
  });

  // Upstream `InstanceEvent` (hub-client) dropped `reasoning` from the turn
  // variant with the session-runtime retirement, so a reloaded turn no longer
  // rehydrates a persisted reasoning trace — only its tools/content do. Live
  // reasoning still streams through the agent-phase path.
  it("rehydrates tools on a tool turn after reload (reasoning is no longer persisted)", () => {
    const toolTurn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Done searching",
      timestamp: "2024-01-01T00:00:30.000Z",
      toolCalls: [
        {
          name: "grep",
          arguments: { pattern: "Acme" },
          result: "found",
          isError: false,
        },
      ],
    };
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "search"),
        toolTurn,
        assistantMail("a1", "Done searching"),
      ],
      streaming: "",
    });
    const agent = messages.find((m) => m.role === "agent");
    expect(agent?.reasoning).toBeUndefined();
    expect(agent?.toolCalls?.[0]?.name).toBe("grep");
    expect(agent?.content).toBe("Done searching");
  });

  it("does not carry a reasoning trace onto the polished mail (transport retired)", () => {
    const textTurn: InstanceEvent = {
      kind: "turn",
      turnId: "t1",
      content: "Polished reply",
      timestamp: "2024-01-01T00:00:30.000Z",
    };
    const { messages } = composeChatMessages({
      events: [
        userMail("u1", "go"),
        textTurn,
        assistantMail("a1", "Polished reply"),
      ],
      streaming: "",
    });
    const agent = messages.find((m) => m.role === "agent");
    expect(agent?.id).toBe("a1");
    expect(agent?.reasoning).toBeUndefined();
    expect(agent?.content).toBe("Polished reply");
  });
});
