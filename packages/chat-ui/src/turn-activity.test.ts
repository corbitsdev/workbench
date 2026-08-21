import { describe, expect, test } from "bun:test";

import { nextTurnActivityState } from "./turn-activity";

function agentEvent(inner: unknown) {
  return { eventType: "chat.agent", data: inner };
}

describe("nextTurnActivityState (CL-6196: live tool-call and thinking states)", () => {
  test("a non chat.agent event never opens or changes the activity", () => {
    expect(
      nextTurnActivityState(null, { eventType: "chat.typing", data: {} }, 0),
    ).toBeNull();
  });

  test("reactor.start opens an empty activity, clearing any leftover from a previous turn", () => {
    const leftover = nextTurnActivityState(
      null,
      agentEvent({
        type: "tool.start",
        seq: 0,
        data: { call: { id: "c1", name: "search", arguments: {} } },
      }),
      0,
    );
    expect(leftover?.toolCalls).toHaveLength(1);

    const cleared = nextTurnActivityState(
      leftover,
      agentEvent({ type: "reactor.start", seq: 1, data: {} }),
      0,
    );
    expect(cleared).toEqual({
      toolCalls: [],
      thinking: { active: false, charCount: 0 },
      retryCount: 0,
    });
  });

  test("reactor.done, reactor.error, inference.done, and inference.error finalize the turn to null", () => {
    for (const type of [
      "reactor.done",
      "reactor.error",
      "inference.done",
      "inference.error",
    ]) {
      const state = nextTurnActivityState(
        {
          toolCalls: [],
          thinking: { active: true, charCount: 4 },
          retryCount: 1,
        },
        agentEvent({ type, seq: 9, data: {} }),
        0,
      );
      expect(state).toBeNull();
    }
  });

  describe("tool call lifecycle", () => {
    test("inference.tool_call.start opens a running row for the tool", () => {
      const state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.tool_call.start",
          seq: 1,
          data: { callId: "c1", name: "web_search", partial: { text: "" } },
        }),
        1000,
      );
      expect(state?.toolCalls).toEqual([
        {
          callId: "c1",
          name: "web_search",
          input: undefined,
          status: "running",
          startedAtMs: 1000,
          doneAtMs: null,
        },
      ]);
    });

    test("inference.tool_call.end attaches the call's arguments without resetting startedAtMs", () => {
      let state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.tool_call.start",
          seq: 1,
          data: { callId: "c1", name: "mcp_read", partial: { text: "" } },
        }),
        1000,
      );
      state = nextTurnActivityState(
        state,
        agentEvent({
          type: "inference.tool_call.end",
          seq: 2,
          data: {
            callId: "c1",
            name: "mcp_read",
            arguments: { server: "notion", tool: "search_pages" },
            partial: { text: "" },
          },
        }),
        3000,
      );
      expect(state?.toolCalls).toEqual([
        {
          callId: "c1",
          name: "mcp_read",
          input: { server: "notion", tool: "search_pages" },
          status: "running",
          startedAtMs: 1000,
          doneAtMs: null,
        },
      ]);
    });

    test("tool.start opens a row directly (no preceding inference.tool_call.start) using the ToolCall's own arguments", () => {
      const state = nextTurnActivityState(
        null,
        agentEvent({
          type: "tool.start",
          seq: 1,
          data: {
            call: {
              id: "c2",
              name: "mcp_call",
              arguments: { server: "linear", tool: "save_issue" },
            },
          },
        }),
        500,
      );
      expect(state?.toolCalls).toEqual([
        {
          callId: "c2",
          name: "mcp_call",
          input: { server: "linear", tool: "save_issue" },
          status: "running",
          startedAtMs: 500,
          doneAtMs: null,
        },
      ]);
    });

    test("tool.done settles the matching row as a success and freezes its elapsed time", () => {
      let state = nextTurnActivityState(
        null,
        agentEvent({
          type: "tool.start",
          seq: 1,
          data: { call: { id: "c1", name: "search", arguments: {} } },
        }),
        1000,
      );
      state = nextTurnActivityState(
        state,
        agentEvent({
          type: "tool.done",
          seq: 2,
          data: { result: { callId: "c1", content: "ok" } },
        }),
        4000,
      );
      expect(state?.toolCalls).toEqual([
        {
          callId: "c1",
          name: "search",
          input: {},
          status: "success",
          startedAtMs: 1000,
          doneAtMs: 4000,
        },
      ]);
    });

    test("tool.done with isError settles the row as failed, not as a quiet success", () => {
      let state = nextTurnActivityState(
        null,
        agentEvent({
          type: "tool.start",
          seq: 1,
          data: {
            call: { id: "c1", name: "github__get_issue", arguments: {} },
          },
        }),
        1000,
      );
      state = nextTurnActivityState(
        state,
        agentEvent({
          type: "tool.done",
          seq: 2,
          data: {
            result: { callId: "c1", content: "not found", isError: true },
          },
        }),
        2000,
      );
      expect(state?.toolCalls[0]?.status).toBe("failed");
    });

    test("tool.done for an unknown callId is ignored rather than crashing", () => {
      const state = nextTurnActivityState(
        null,
        agentEvent({
          type: "tool.done",
          seq: 1,
          data: { result: { callId: "ghost", content: "ok" } },
        }),
        0,
      );
      expect(state?.toolCalls).toEqual([]);
    });
  });

  describe("thinking accumulation", () => {
    test("inference.thinking.delta turns thinking on and tracks the cumulative char count", () => {
      let state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.thinking.delta",
          seq: 1,
          data: { token: "Let ", partial: { text: "", thinking: "Let " } },
        }),
        0,
      );
      expect(state?.thinking).toEqual({ active: true, charCount: 4 });

      state = nextTurnActivityState(
        state,
        agentEvent({
          type: "inference.thinking.delta",
          seq: 2,
          data: {
            token: "me think",
            partial: { text: "", thinking: "Let me think" },
          },
        }),
        0,
      );
      expect(state?.thinking).toEqual({ active: true, charCount: 12 });
    });

    test("a thinking delta with no partial.thinking falls back to incrementing by the raw token length", () => {
      const state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.thinking.delta",
          seq: 1,
          data: { token: "hmm", partial: { text: "" } },
        }),
        0,
      );
      expect(state?.thinking).toEqual({ active: true, charCount: 3 });
    });

    test("the next non-thinking event freezes the char count and turns thinking off", () => {
      let state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.thinking.delta",
          seq: 1,
          data: { token: "hmm", partial: { text: "", thinking: "hmm" } },
        }),
        0,
      );
      state = nextTurnActivityState(
        state,
        agentEvent({
          type: "inference.tool_call.start",
          seq: 2,
          data: { callId: "c1", name: "search", partial: { text: "" } },
        }),
        0,
      );
      expect(state?.thinking).toEqual({ active: false, charCount: 3 });
    });
  });

  describe("retries", () => {
    test("inference.retry records the attempt number as the retry count", () => {
      const state = nextTurnActivityState(
        null,
        agentEvent({
          type: "inference.retry",
          seq: 1,
          data: { attempt: 2, delayMs: 500, previousError: {} },
        }),
        0,
      );
      expect(state?.retryCount).toBe(2);
    });
  });

  test("a malformed payload is ignored rather than crashing", () => {
    expect(nextTurnActivityState(null, agentEvent(null), 0)).toEqual({
      toolCalls: [],
      thinking: { active: false, charCount: 0 },
      retryCount: 0,
    });
    expect(
      nextTurnActivityState(
        null,
        agentEvent({ type: "tool.start", seq: 1, data: {} }),
        0,
      ),
    ).toEqual({
      toolCalls: [],
      thinking: { active: false, charCount: 0 },
      retryCount: 0,
    });
  });
});
