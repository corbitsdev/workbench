import { describe, expect, test } from "bun:test";
import type { InferenceEvent } from "@intx/types/runtime";

import {
  createInlineToolJsonState,
  reclassifyInlineToolJsonEvents,
} from "./inline-tool-json";

const CL_7186_PAYLOAD =
  '{"name":"memory_search","parameters":{"query":"this person"}}';

function textDelta(token: string, seq = 1): InferenceEvent {
  return {
    type: "inference.text.delta",
    seq,
    data: { token, partial: { text: token }, index: 0 },
  };
}

function usageEvent(seq = 2): InferenceEvent {
  return {
    type: "inference.usage",
    seq,
    data: {
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      source: { sourceId: "ollama-test", provider: "ollama", model: "qwen" },
    },
  };
}

function reclassify(
  events: readonly InferenceEvent[],
  declaredNames: Iterable<string>,
  opts?: { flush?: boolean },
): InferenceEvent[] {
  return reclassifyInlineToolJsonEvents(
    events,
    createInlineToolJsonState(declaredNames),
    opts,
  );
}

function toolStarts(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.type === "inference.tool_call.start");
}

function textDeltas(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.type === "inference.text.delta");
}

function toolCallIds(events: readonly InferenceEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.type === "inference.tool_call.start" ||
        event.type === "inference.tool_call.delta",
    )
    .map((event) => (event.data as { callId: string }).callId);
}

function expectSharedToolCallId(events: readonly InferenceEvent[]): void {
  const ids = toolCallIds(events);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids)).toEqual(new Set(["ollama-inline-0"]));
}

function argumentFragments(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.type === "inference.tool_call.delta")
    .map(
      (event) => (event.data as { argumentFragment: string }).argumentFragment,
    )
    .join("");
}

describe("reclassifyInlineToolJsonEvents", () => {
  test("the CL-7186 memory_search JSON becomes a tool_call.start with no text", () => {
    const out = reclassify(
      [textDelta(CL_7186_PAYLOAD), usageEvent()],
      ["memory_search"],
    );
    expect(textDeltas(out)).toEqual([]);
    const starts = toolStarts(out);
    expect(starts).toHaveLength(1);
    expect((starts[0]?.data as { name: string }).name).toBe("memory_search");
    expectSharedToolCallId(out);
    expect(JSON.parse(argumentFragments(out))).toEqual({
      query: "this person",
    });
  });

  test("chunks split across a JSON boundary still salvage once the object completes", () => {
    const state = createInlineToolJsonState(["memory_search"]);
    const splitAt = CL_7186_PAYLOAD.indexOf("memory_search") + 6;
    const first = reclassifyInlineToolJsonEvents(
      [textDelta(CL_7186_PAYLOAD.slice(0, splitAt))],
      state,
    );
    expect(textDeltas(first)).toEqual([]);
    expect(toolStarts(first)).toEqual([]);

    const second = reclassifyInlineToolJsonEvents(
      [textDelta(CL_7186_PAYLOAD.slice(splitAt))],
      state,
    );
    expect(textDeltas(second)).toEqual([]);
    expect(toolStarts(second)).toEqual([]);

    const flushed = reclassifyInlineToolJsonEvents([], state, { flush: true });
    expect(textDeltas(flushed)).toEqual([]);
    expect((toolStarts(flushed)[0]?.data as { name: string }).name).toBe(
      "memory_search",
    );
    expectSharedToolCallId(flushed);
    expect(JSON.parse(argumentFragments(flushed))).toEqual({
      query: "this person",
    });
  });

  test("arguments is accepted as the args object, same as parameters", () => {
    const payload =
      '{"name":"memory_search","arguments":{"query":"this person"}}';
    const out = reclassify([textDelta(payload)], ["memory_search"], {
      flush: true,
    });
    expect(textDeltas(out)).toEqual([]);
    expectSharedToolCallId(out);
    expect(JSON.parse(argumentFragments(out))).toEqual({
      query: "this person",
    });
  });

  test("an unknown name stays text even when the JSON shape matches", () => {
    const payload =
      '{"name":"not_a_tool","parameters":{"query":"this person"}}';
    const original = [textDelta(payload)];
    const out = reclassify(original, ["memory_search"], { flush: true });
    expect(out).toEqual(original);
    expect(toolStarts(out)).toEqual([]);
  });

  test("declared-name gate: no tools on the request leaves the JSON as text", () => {
    const original = [textDelta(CL_7186_PAYLOAD)];
    const out = reclassify(original, [], { flush: true });
    expect(out).toEqual(original);
    expect(toolStarts(out)).toEqual([]);
  });

  test("legitimate JSON answers stay text: extra keys, arrays, mixed prose, tutorials", () => {
    const samples = [
      '{"name":"memory_search","parameters":{"query":"this person"},"title":"example"}',
      '[{"name":"memory_search","parameters":{"query":"this person"}}]',
      'Call it like this:\n{"name":"memory_search","parameters":{"query":"this person"}}',
      '{"ok":true,"count":3}',
      '{"name":"memory_search"}',
      "```json\n" + CL_7186_PAYLOAD + "\n```",
    ];
    for (const sample of samples) {
      const original = [textDelta(sample)];
      const out = reclassify(original, ["memory_search"], { flush: true });
      expect(out).toEqual(original);
      expect(toolStarts(out)).toEqual([]);
    }
  });

  test("incomplete JSON at flush stays the original text", () => {
    const original = [textDelta('{"name":"memory_search"')];
    const out = reclassify(original, ["memory_search"], { flush: true });
    expect(out).toEqual(original);
  });

  test("ordinary prose with tools declared passes through unchanged", () => {
    const original = [textDelta("hello, how can I help?")];
    const out = reclassify(original, ["memory_search"]);
    expect(out).toEqual(original);
  });

  test("salvaged tool_call events reuse the text block index so they cannot collide with leftover content", () => {
    const out = reclassify([textDelta(CL_7186_PAYLOAD)], ["memory_search"], {
      flush: true,
    });
    const start = toolStarts(out)[0];
    expect((start?.data as { index?: number }).index).toBe(0);
    expectSharedToolCallId(out);
    expect(textDeltas(out)).toEqual([]);
  });
});
