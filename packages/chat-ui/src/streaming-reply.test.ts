import { describe, expect, test } from "bun:test";

import {
  hydrateStreamingReplyFromTurn,
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

  test("inference.start never wipes tokens already streamed", () => {
    const state = { text: "Hello" };
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "inference.start", seq: 9, data: { model: "x" } }),
      ),
    ).toBe(state);
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

  test("inference.done keeps an empty pending reply — the next inference round is still owed", () => {
    const pending = { text: "" };
    expect(
      nextStreamingReplyState(
        pending,
        agentEvent({
          type: "inference.done",
          seq: 5,
          data: { turn: {}, usage: {}, source: "primary" },
        }),
      ),
    ).toBe(pending);
  });

  test("inference.done while idle stays idle — a late done is not a new turn", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({
          type: "inference.done",
          seq: 5,
          data: { turn: {}, usage: {}, source: "primary" },
        }),
      ),
    ).toBeNull();
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

describe("nextStreamingReplyState (CL-6376: the typing pulse clears on a dispatch failure too)", () => {
  test("a chat.message carrying a turnFailed part clears a pending reply", () => {
    const state = { text: "" };
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          parts: [
            { kind: "text", text: "I didn't get that one", turnFailed: true },
          ],
        },
      }),
    ).toBeNull();
  });

  test("an ordinary chat.message (no turnFailed part) leaves the reply untouched", () => {
    const state = { text: "" };
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: { id: "msg_1", parts: [{ kind: "text", text: "hi" }] },
      }),
    ).toBe(state);
  });

  test("a chat.message with no pending reply stays null", () => {
    expect(
      nextStreamingReplyState(null, {
        eventType: "chat.message",
        data: { parts: [{ kind: "text", text: "x", turnFailed: true }] },
      }),
    ).toBeNull();
  });
});

describe("nextStreamingReplyState (CL-6432: folded-run turns end on connector.reply / message.run.ended, not reactor.done)", () => {
  test("connector.reply clears the reply — the orchestrator posts the persisted message off this very event", () => {
    expect(
      nextStreamingReplyState(
        { text: "Hey! What are you working on today?" },
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey! What are you working on today?" },
        }),
      ),
    ).toBeNull();
  });

  test("connector.reply clears an empty pending reply too — the reply is finalized even when its tokens never streamed here", () => {
    expect(
      nextStreamingReplyState(
        { text: "" },
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey!" },
        }),
      ),
    ).toBeNull();
  });

  test("message.run.ended clears an empty pending reply — the turn bracket closed, nothing more streams", () => {
    expect(
      nextStreamingReplyState(
        { text: "" },
        agentEvent({
          type: "message.run.ended",
          seq: 12,
          data: { status: "completed" },
        }),
      ),
    ).toBeNull();
  });

  test("connector.reply and message.run.ended while idle stay idle", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({ type: "connector.reply", seq: 9, data: { content: "x" } }),
      ),
    ).toBeNull();
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({
          type: "message.run.ended",
          seq: 12,
          data: { status: "completed" },
        }),
      ),
    ).toBeNull();
  });

  test("the Myra repro: a post-reply tool round reopens the pulse and the turn's own terminal events shut it", () => {
    // Round 1: the visible reply streams and its inference.done hands off
    // to the persisted message.
    let state = openPendingReply(null);
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 1, data: { model: "x" } }),
    );
    state = nextStreamingReplyState(
      state,
      delta("Hey! What are you working on today?"),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "inference.done",
        seq: 4,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    expect(state).toBeNull();

    // Round 2: a tool-only follow-up (memory writes) reopens the pulse and
    // its textless inference.done deliberately leaves it up mid-turn.
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 5, data: { model: "x" } }),
    );
    expect(state).toEqual({ text: "" });
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "inference.done",
        seq: 7,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    expect(state).toEqual({ text: "" });

    // The folded run never emits reactor.done — its turn ends here.
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "connector.reply",
        seq: 8,
        data: { content: "Hey!" },
      }),
    );
    expect(state).toBeNull();
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "message.run.ended",
        seq: 9,
        data: { status: "completed" },
      }),
    );
    expect(state).toBeNull();
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

  test("a pending reply with no tokens names the workbench's agent participant", () => {
    expect(typingAgentNames({ text: "" }, [HUMAN, MYRA])).toEqual(["Myra"]);
  });

  test("once tokens stream the bubble takes over — the typing line goes quiet", () => {
    expect(typingAgentNames({ text: "Hel" }, [HUMAN, MYRA])).toEqual([]);
  });

  test('a slugified handle is shown as a display name — "myra" reads "Myra"', () => {
    expect(
      typingAgentNames({ text: "" }, [
        { address: "myra@agents.example", handle: "myra" },
      ]),
    ).toEqual(["Myra"]);
  });

  test("no agent participant on the workbench means nobody is named", () => {
    expect(typingAgentNames({ text: "" }, [HUMAN])).toEqual([]);
  });
});

describe("hydrateStreamingReplyFromTurn (CL-6380: reattach snapshot)", () => {
  test("no running turn resumes to nothing", () => {
    expect(hydrateStreamingReplyFromTurn(null)).toBeNull();
  });

  test("a running turn with committed text opens the reply carrying it", () => {
    expect(
      hydrateStreamingReplyFromTurn({ textSnapshot: "streamed so far" }),
    ).toEqual({ text: "streamed so far" });
  });

  test("a running turn with no text yet opens the same empty pending pulse as openPendingReply", () => {
    expect(hydrateStreamingReplyFromTurn({ textSnapshot: null })).toEqual({
      text: "",
    });
  });
});
