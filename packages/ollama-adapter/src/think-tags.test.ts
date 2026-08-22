import { describe, expect, test } from "bun:test";
import type { InferenceEvent } from "@intx/types/runtime";

import { createThinkSplitState, reclassifyThinkingEvents } from "./think-tags";

function textDelta(token: string, seq = 1): InferenceEvent {
  return {
    type: "inference.text.delta",
    seq,
    data: { token, partial: { text: token }, index: 0 },
  };
}

describe("reclassifyThinkingEvents", () => {
  test("a whole <think>...</think> span in one token becomes thinking-delta, not text-delta", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>plan the approach</think>Here is the answer.")],
      state,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("inference.thinking.delta");
    expect((out[0]?.data as { token: string }).token).toBe("plan the approach");
    expect(out[1]?.type).toBe("inference.text.delta");
    expect((out[1]?.data as { token: string }).token).toBe("Here is the answer.");
  });

  test("a <think> span split across multiple chunks stays classified as thinking across the boundary", () => {
    const state = createThinkSplitState();
    const first = reclassifyThinkingEvents([textDelta("<think>step one, ")], state);
    const second = reclassifyThinkingEvents([textDelta("step two</think>final reply")], state);

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("inference.thinking.delta");
    expect(second).toHaveLength(2);
    expect(second[0]?.type).toBe("inference.thinking.delta");
    expect((second[0]?.data as { token: string }).token).toBe("step two");
    expect(second[1]?.type).toBe("inference.text.delta");
    expect((second[1]?.data as { token: string }).token).toBe("final reply");
  });

  test("ordinary text with no <think> tag passes through as text-delta unchanged", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents([textDelta("just a normal reply")], state);
    expect(out).toEqual([textDelta("just a normal reply")]);
  });

  test("non-text events (tool calls, done) pass through untouched", () => {
    const state = createThinkSplitState();
    const toolCallStart: InferenceEvent = {
      type: "inference.tool_call.start",
      seq: 1,
      data: { callId: "call-1", name: "slack__post_message", partial: { text: "" } },
    };
    const out = reclassifyThinkingEvents([toolCallStart], state);
    expect(out).toEqual([toolCallStart]);
  });

  test("thinking events never share an index with the text stream, so the harness's per-index blockMap can't collide them", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>internal notes</think>visible reply", 3)],
      state,
    );
    const thinkingEvent = out.find((event) => event.type === "inference.thinking.delta");
    const textEvent = out.find((event) => event.type === "inference.text.delta");
    expect((thinkingEvent?.data as { index?: number }).index).not.toBe(
      (textEvent?.data as { index?: number }).index,
    );
    expect((textEvent?.data as { index?: number }).index).toBe(0);
  });

  test("cumulative partial.text/partial.thinking reflect only their own kind, never the raw tags", () => {
    const state = createThinkSplitState();
    const out = reclassifyThinkingEvents(
      [textDelta("<think>internal notes</think>visible reply")],
      state,
    );
    const thinkingEvent = out.find((event) => event.type === "inference.thinking.delta");
    const textEvent = out.find((event) => event.type === "inference.text.delta");
    expect((thinkingEvent?.data as { partial: { thinking?: string } }).partial.thinking).toBe(
      "internal notes",
    );
    expect((textEvent?.data as { partial: { text: string } }).partial.text).toBe("visible reply");
    expect((textEvent?.data as { partial: { text: string } }).partial.text).not.toContain("<think>");
  });
});
