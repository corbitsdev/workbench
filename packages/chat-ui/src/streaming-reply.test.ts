import { describe, expect, test } from "bun:test";

import {
  nextStreamingReplyState,
  openPendingReply,
  typingAgentNames,
} from "./streaming-reply";

const HUMAN = { address: "prn_sawyer", handle: "Sawyer" };
const MYRA = { address: "myra@agents.example", handle: "Myra" };

function agentEvent(inner: unknown) {
  return { eventType: "chat.agent", data: inner };
}

function delta(text: string) {
  return agentEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: text.slice(-1), partial: { text } },
  });
}

describe("nextStreamingReplyState (CL-6115: token deltas fold into a growing reply)", () => {
  test("a non chat.agent event never opens or changes the reply", () => {
    expect(
      nextStreamingReplyState(null, { eventType: "chat.typing", data: {} }),
    ).toBeNull();
    const current = { text: "hi" };
    expect(
      nextStreamingReplyState(current, {
        eventType: "chat.pin",
        data: { type: "inference.text.delta" },
      }),
    ).toBe(current);
  });

  test("inference.start opens an empty in-progress reply", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({ type: "inference.start", seq: 0, data: { model: "x" } }),
      ),
    ).toEqual({ text: "" });
  });

  test("each text delta replaces the reply with that delta's cumulative text", () => {
    let state = nextStreamingReplyState(
      null,
      agentEvent({ type: "inference.start", seq: 0, data: { model: "x" } }),
    );
    state = nextStreamingReplyState(state, delta("Hel"));
    expect(state).toEqual({ text: "Hel" });
    state = nextStreamingReplyState(state, delta("Hello"));
    expect(state).toEqual({ text: "Hello" });
  });

  test("inference.done clears the reply — the persisted message takes over", () => {
    const state = nextStreamingReplyState(
      { text: "Hello there" },
      agentEvent({
        type: "inference.done",
        seq: 5,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    expect(state).toBeNull();
  });

  test("inference.error clears the reply rather than leaving a stuck cursor", () => {
    const state = nextStreamingReplyState(
      { text: "Hello" },
      agentEvent({
        type: "inference.error",
        seq: 5,
        data: { error: {}, partial: { text: "Hello" } },
      }),
    );
    expect(state).toBeNull();
  });

  test("an event with no known inner shape (tool calls, usage) leaves the reply untouched", () => {
    const state = { text: "Hello" };
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({
          type: "inference.tool_call.start",
          seq: 3,
          data: { callId: "c1", name: "search", partial: { text: "Hello" } },
        }),
      ),
    ).toBe(state);
  });

  test("reactor.start opens an empty reply when idle — the turn began before any tokens", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({ type: "reactor.start", seq: 0, data: {} }),
      ),
    ).toEqual({ text: "" });
  });

  test("reactor.start never resets an in-progress reply", () => {
    const state = { text: "Hello" };
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "reactor.start", seq: 9, data: {} }),
      ),
    ).toBe(state);
  });

  test("reactor.done and reactor.error clear the reply — the whole turn is over", () => {
    for (const type of ["reactor.done", "reactor.error"]) {
      expect(
        nextStreamingReplyState(
          { text: "Hello" },
          agentEvent({ type, seq: 10, data: {} }),
        ),
      ).toBeNull();
    }
  });

  test("a malformed delta payload (no partial.text) is ignored rather than crashing", () => {
    const state = { text: "Hello" };
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "inference.text.delta", seq: 2, data: {} }),
      ),
    ).toBe(state);
    expect(nextStreamingReplyState(state, agentEvent(null))).toBe(state);
    expect(nextStreamingReplyState(state, agentEvent("garbage"))).toBe(state);
  });
});

describe("openPendingReply", () => {
  test("opens an empty pending reply when idle", () => {
    expect(openPendingReply(null)).toEqual({ text: "" });
  });

  test("never resets a reply already streaming", () => {
    const state = { text: "Hel" };
    expect(openPendingReply(state)).toBe(state);
  });
});

describe("typingAgentNames", () => {
  test("no active reply means nobody is typing", () => {
    expect(typingAgentNames(null, [MYRA])).toEqual([]);
  });

  test("a pending reply with no tokens names the channel's agent participant", () => {
    expect(typingAgentNames({ text: "" }, [HUMAN, MYRA])).toEqual(["Myra"]);
  });

  test("once tokens stream the bubble takes over — the typing line goes quiet", () => {
    expect(typingAgentNames({ text: "Hel" }, [HUMAN, MYRA])).toEqual([]);
  });

  test("no agent participant on the channel means nobody is named", () => {
    expect(typingAgentNames({ text: "" }, [HUMAN])).toEqual([]);
  });
});
