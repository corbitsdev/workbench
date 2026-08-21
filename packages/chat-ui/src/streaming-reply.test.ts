import { describe, expect, test } from "bun:test";

import {
  hydrateStreamingReplyFromTurn,
  isPendingReply,
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

const AWAITING_EMPTY = { phase: "awaiting", text: "" } as const;

function awaiting(text: string) {
  return { phase: "awaiting", text } as const;
}

describe("nextStreamingReplyState (CL-6115: token deltas fold into a growing reply)", () => {
  test("a non chat.agent event never opens or changes the reply", () => {
    expect(
      nextStreamingReplyState(null, { eventType: "chat.typing", data: {} }),
    ).toBeNull();
    const current = awaiting("hi");
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
    ).toEqual(AWAITING_EMPTY);
  });

  test("inference.start never wipes tokens already streamed", () => {
    const state = awaiting("Hello");
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
    expect(state).toEqual(awaiting("Hel"));
    state = nextStreamingReplyState(state, delta("Hello"));
    expect(state).toEqual(awaiting("Hello"));
  });

  test("inference.done clears the reply — the persisted message takes over", () => {
    const state = nextStreamingReplyState(
      awaiting("Hello there"),
      agentEvent({
        type: "inference.done",
        seq: 5,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    expect(state).toBeNull();
  });

  test("inference.done keeps an empty pending reply — the next inference round is still owed", () => {
    const pending = awaiting("");
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
      awaiting("Hello"),
      agentEvent({
        type: "inference.error",
        seq: 5,
        data: { error: {}, partial: { text: "Hello" } },
      }),
    );
    expect(state).toBeNull();
  });

  test("an event with no known inner shape (tool calls, usage) leaves the reply untouched", () => {
    const state = awaiting("Hello");
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
    ).toEqual(AWAITING_EMPTY);
  });

  test("reactor.start never resets an in-progress reply", () => {
    const state = awaiting("Hello");
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
          awaiting("Hello"),
          agentEvent({ type, seq: 10, data: {} }),
        ),
      ).toBeNull();
    }
  });

  test("a malformed delta payload (no partial.text) is ignored rather than crashing", () => {
    const state = awaiting("Hello");
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
    const state = awaiting("");
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
    const state = awaiting("");
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

describe("nextStreamingReplyState (CL-false-no-reply: rendered content, not a lifecycle event, ends the turn)", () => {
  test("a chat.message from the awaiting turn's agent moves straight to replied — the reply already rendered, connector.reply or not", () => {
    const state = awaiting("Full answer.");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [{ kind: "text", text: "Full answer." }],
        },
      }),
    ).toEqual({ phase: "replied" });
  });

  test("a chat.message from the agent's own undelivered-notice address (turnFailed) is never mistaken for a rendered reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [
            { kind: "text", text: "I didn't get that one", turnFailed: true },
          ],
        },
      }),
    ).toBeNull();
  });

  test("a chat.message from a human sender never ends the turn — it's not the agent's reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: HUMAN.address },
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    ).toBe(state);
  });

  test("a chat.message with no content parts never ends the turn", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [],
        },
      }),
    ).toBe(state);
  });
});

describe("nextStreamingReplyState (CL-6432 reopened: a folded run parks after the reply — post-reply tool rounds never re-open the pulse)", () => {
  test("connector.reply moves the turn to the replied phase — the persisted message takes over the timeline", () => {
    expect(
      nextStreamingReplyState(
        awaiting("Hey! What are you working on right now?"),
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey! What are you working on right now?" },
        }),
      ),
    ).toEqual({ phase: "replied" });
  });

  test("connector.reply settles an empty pending reply too — the reply is finalized even when its tokens never streamed here", () => {
    expect(
      nextStreamingReplyState(
        awaiting(""),
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey!" },
        }),
      ),
    ).toEqual({ phase: "replied" });
  });

  test("the replied phase renders nothing — no pulse, no bubble", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 9, data: { content: "x" } }),
    );
    expect(isPendingReply(replied)).toBe(false);
    expect(typingAgentNames(replied, [HUMAN, MYRA])).toEqual([]);
  });

  test("message.run.started opens the next turn's pulse — the one event that ends the replied phase from the stream", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 9, data: { content: "x" } }),
    );
    expect(
      nextStreamingReplyState(
        replied,
        agentEvent({ type: "message.run.started", seq: 0, data: {} }),
      ),
    ).toEqual(AWAITING_EMPTY);
  });

  test("message.run.ended returns to idle from any phase — the bracket closed, nothing more streams", () => {
    for (const state of [awaiting(""), awaiting("Hello")]) {
      expect(
        nextStreamingReplyState(
          state,
          agentEvent({
            type: "message.run.ended",
            seq: 12,
            data: { status: "completed" },
          }),
        ),
      ).toBeNull();
    }
  });

  test("the live Myra sequence: reply posts, memory rounds follow, the run parks — the pulse never comes back", () => {
    // Captured from a live folded run (scratch stack, real provider): the
    // run brackets open per dequeued message, the visible reply streams
    // and posts via connector.reply, then post-reply tool-only rounds
    // (memory writes) run inference again, and the run PARKS — no
    // message.run.ended ever arrives.
    let state = openPendingReply(null);
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "message.run.started", seq: 0, data: {} }),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 1, data: { model: "x" } }),
    );
    expect(isPendingReply(state)).toBe(true);
    state = nextStreamingReplyState(
      state,
      delta("Hey! What are you working on right now?"),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "inference.done",
        seq: 4,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "connector.reply",
        seq: 5,
        data: { content: "Hey! What are you working on right now?" },
      }),
    );
    expect(state).toEqual({ phase: "replied" });

    // Post-reply memory rounds: inference.start must NOT re-open the
    // pulse, and the textless inference.done must not strand one either.
    for (const round of [
      agentEvent({ type: "inference.start", seq: 6, data: { model: "x" } }),
      agentEvent({
        type: "inference.tool_call.start",
        seq: 7,
        data: { callId: "c1", name: "memory_write" },
      }),
      agentEvent({
        type: "tool.done",
        seq: 8,
        data: { result: { callId: "c1", content: [], isError: false } },
      }),
      agentEvent({
        type: "inference.done",
        seq: 9,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
      agentEvent({ type: "inference.start", seq: 10, data: { model: "x" } }),
      agentEvent({
        type: "inference.done",
        seq: 11,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    ]) {
      state = nextStreamingReplyState(state, round);
      expect(state).toEqual({ phase: "replied" });
      expect(isPendingReply(state)).toBe(false);
    }
    // The run parks here: no message.run.ended, and the state stays
    // invisible until the next turn's message.run.started.
  });

  test("the next user turn brings the pulse back — replied never suppresses a genuinely new turn", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 5, data: { content: "x" } }),
    );
    // Locally, the send itself re-opens the pulse...
    expect(openPendingReply(replied)).toEqual(AWAITING_EMPTY);
    // ...and on the stream, the dequeued message's own bracket does.
    let state = nextStreamingReplyState(
      replied,
      agentEvent({ type: "message.run.started", seq: 0, data: {} }),
    );
    expect(isPendingReply(state)).toBe(true);
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 1, data: { model: "x" } }),
    );
    expect(isPendingReply(state)).toBe(true);
  });
});

describe("openPendingReply", () => {
  test("opens an empty pending reply when idle", () => {
    expect(openPendingReply(null)).toEqual(AWAITING_EMPTY);
  });

  test("opens an empty pending reply from a replied previous turn", () => {
    expect(openPendingReply({ phase: "replied" })).toEqual(AWAITING_EMPTY);
  });

  test("never resets a reply already streaming", () => {
    const state = awaiting("Hel");
    expect(openPendingReply(state)).toBe(state);
  });
});

describe("typingAgentNames", () => {
  test("no active reply means nobody is typing", () => {
    expect(typingAgentNames(null, [MYRA])).toEqual([]);
  });

  test("a pending reply with no tokens names the workbench's agent participant", () => {
    expect(typingAgentNames(awaiting(""), [HUMAN, MYRA])).toEqual(["Myra"]);
  });

  test("once tokens stream the bubble takes over — the typing line goes quiet", () => {
    expect(typingAgentNames(awaiting("Hel"), [HUMAN, MYRA])).toEqual([]);
  });

  test('a slugified handle is shown as a display name — "myra" reads "Myra"', () => {
    expect(
      typingAgentNames(awaiting(""), [
        { address: "myra@agents.example", handle: "myra" },
      ]),
    ).toEqual(["Myra"]);
  });

  test("no agent participant on the workbench means nobody is named", () => {
    expect(typingAgentNames(awaiting(""), [HUMAN])).toEqual([]);
  });
});

describe("hydrateStreamingReplyFromTurn (CL-6380: reattach snapshot)", () => {
  test("no running turn resumes to nothing", () => {
    expect(hydrateStreamingReplyFromTurn(null)).toBeNull();
  });

  test("a running turn with committed text opens the reply carrying it", () => {
    expect(
      hydrateStreamingReplyFromTurn({ textSnapshot: "streamed so far" }),
    ).toEqual(awaiting("streamed so far"));
  });

  test("a running turn with no text yet opens the same empty pending pulse as openPendingReply", () => {
    expect(hydrateStreamingReplyFromTurn({ textSnapshot: null })).toEqual(
      AWAITING_EMPTY,
    );
  });
});
