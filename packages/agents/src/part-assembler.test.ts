import { describe, expect, it } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createPartAssembler } from "./part-assembler";

type Handler = (raw: unknown) => void;

function createFakeTransport(): {
  transport: Transport;
  emit: (raw: unknown) => void;
} {
  const handlers: Handler[] = [];
  const transport = {
    subscribe: (
      _path: string,
      handler: Handler,
      _opts?: { eventName?: string },
    ) => {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  } as unknown as Transport;
  return {
    transport,
    emit: (raw: unknown) => {
      for (const h of [...handlers]) h(raw);
    },
  };
}

const params = { tenantId: "t1", instanceId: "i1" };

describe("createPartAssembler", () => {
  it("resets ordered parts, live text, and reasoning on turn commit but keeps tool names durable", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "exa_search" },
    });
    emit({
      type: "inference.text.delta",
      data: { partial: { text: "hello" } },
    });
    expect(assembler.parts.length).toBeGreaterThan(0);
    expect(assembler.text).toBe("hello");

    emit({ type: "turn.committed" });

    expect(assembler.parts).toEqual([]);
    expect(assembler.text).toBe("");
    expect(assembler.toolNames.get("c1")).toBe("exa_search");
  });

  it("reconstructs think -> tool -> think interleaving by snapshotting the cumulative reasoning blob at each tool boundary", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "Let me check the records." } },
    });
    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "crm_lookup" },
    });
    emit({
      type: "inference.thinking.delta",
      data: {
        partial: {
          thinking: "Let me check the records.Now reconciling the result.",
        },
      },
    });

    expect(assembler.parts.map((p) => p.type)).toEqual([
      "reasoning",
      "tool",
      "reasoning",
    ]);
    expect(assembler.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Let me check the records.",
    });
    expect(assembler.parts[2]).toMatchObject({
      type: "reasoning",
      text: "Now reconciling the result.",
    });
  });

  it("derives activity from the trailing part's open state: reasoning open -> thinking, pending tool -> tool_running", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "Thinking..." } },
    });
    expect(assembler.activity).toEqual({ type: "thinking" });

    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "exa_search" },
    });
    expect(assembler.activity).toEqual({
      type: "tool_running",
      name: "exa_search",
    });
  });

  it("closes the open part locally on abort, settling activity to null without waiting for a reset event", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "Thinking..." } },
    });
    expect(assembler.activity).toEqual({ type: "thinking" });

    assembler.closeOpenPart();

    expect(assembler.activity).toBeNull();
    // The part itself (and its text) is preserved — only its "open" status
    // changes, so the reasoning already streamed is not discarded.
    expect(assembler.parts).toHaveLength(1);
    expect(assembler.parts[0]).toMatchObject({ text: "Thinking..." });
  });

  it("stays idle with no open part and no active inference", () => {
    const { transport } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);
    expect(assembler.activity).toBeNull();
  });

  it("reports no activity for a content-less inference.start with no open part (CL-3871)", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);
    emit({ type: "inference.start" });
    expect(assembler.activity).toBeNull();
  });

  it("still reports thinking once a reasoning part actually opens after inference.start", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);
    emit({ type: "inference.start" });
    expect(assembler.activity).toBeNull();
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "Thinking..." } },
    });
    expect(assembler.activity).toEqual({ type: "thinking" });
  });

  it("does not linger as thinking below a settled answer after a second content-less inference.start (CL-3871)", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.text.delta",
      data: { partial: { text: "Here is my answer." } },
    });
    expect(assembler.activity).toBeNull();
    emit({ type: "turn.committed" });
    expect(assembler.activity).toBeNull();

    // A reactor follow-up (queued mail, decision-only pass) fires a second,
    // content-less inference.start after the visible turn already settled.
    emit({ type: "inference.start" });
    expect(assembler.activity).toBeNull();
  });

  it("captures inline images from inference.image_output and clears them on turn end", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.image_output",
      data: {
        image: {
          source: { kind: "base64", mimeType: "image/png", data: "abc123" },
        },
      },
    });

    expect(assembler.liveImages).toEqual([
      { mimeType: "image/png", data: "abc123" },
    ]);
    expect(assembler.parts.some((p) => p.type === "file")).toBe(true);

    emit({ type: "turn.committed" });
    expect(assembler.liveImages).toEqual([]);
  });

  it("resets on reactor.abort and reactor.error the same as turn.committed", () => {
    const { transport, emit } = createFakeTransport();
    for (const resetEvent of [
      "reactor.abort",
      "reactor.error",
      "inference.error",
    ]) {
      const assembler = createPartAssembler(transport, params);
      emit({
        type: "inference.text.delta",
        data: { partial: { text: "partial" } },
      });
      expect(assembler.text).toBe("partial");
      emit({ type: resetEvent });
      expect(assembler.text).toBe("");
    }
  });

  it("stop tears down the underlying subscription", () => {
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);
    assembler.stop();
    emit({
      type: "inference.text.delta",
      data: { partial: { text: "should not apply" } },
    });
    expect(assembler.text).toBe("");
  });

  it("records the tool name from inference.tool_call.end and settles the pending tool part", () => {
    // A subscriber that connects mid-tool-call only ever sees the .end event;
    // the name must still resolve (the original tool-name tracker pinned this).
    const { transport, emit } = createFakeTransport();
    const assembler = createPartAssembler(transport, params);

    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "exa_search" },
    });
    expect(assembler.activity).toEqual({
      type: "tool_running",
      name: "exa_search",
    });

    emit({
      type: "inference.tool_call.end",
      data: { callId: "c1", name: "exa_search" },
    });
    const toolPart = assembler.parts.find((p) => p.type === "tool");
    expect(toolPart).toMatchObject({ state: "output-available" });
    // No longer pending — the derived activity must not read "running".
    expect(assembler.activity).not.toEqual({
      type: "tool_running",
      name: "exa_search",
    });

    const late = createPartAssembler(transport, params);
    emit({
      type: "inference.tool_call.end",
      data: { callId: "c2", name: "crm_lookup" },
    });
    expect(late.toolNames.get("c2")).toBe("crm_lookup");
  });
});

describe("part-assembler boundary behavior", () => {
  it("does not re-emit the cumulative text blob in a second text part after a tool boundary", () => {
    const { transport, emit } = createFakeTransport();
    const a = createPartAssembler(transport, params);
    emit({
      type: "inference.text.delta",
      data: { partial: { text: "Before tool." } },
    });
    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "exa" },
    });
    emit({
      type: "inference.text.delta",
      data: { partial: { text: "Before tool.After tool." } },
    });
    const textParts = a.parts.filter((p) => p.type === "text");
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual([
      "Before tool.",
      "After tool.",
    ]);
  });

  it("keeps updating the open text part after an interleaved image output", () => {
    const { transport, emit } = createFakeTransport();
    const a = createPartAssembler(transport, params);
    emit({ type: "inference.text.delta", data: { partial: { text: "abc" } } });
    emit({
      type: "inference.image_output",
      data: {
        image: { source: { kind: "base64", mimeType: "image/png", data: "x" } },
      },
    });
    emit({
      type: "inference.text.delta",
      data: { partial: { text: "abcdef" } },
    });
    const textParts = a.parts.filter((p) => p.type === "text");
    const joined = textParts.map((p) => (p as { text: string }).text).join("");
    expect(joined).toContain("def");
    expect(a.text).toBe("abcdef");
  });

  it("keeps updating the open reasoning part after an interleaved image output", () => {
    const { transport, emit } = createFakeTransport();
    const a = createPartAssembler(transport, params);
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "abc" } },
    });
    emit({
      type: "inference.image_output",
      data: {
        image: { source: { kind: "base64", mimeType: "image/png", data: "x" } },
      },
    });
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "abcdef" } },
    });
    const rParts = a.parts.filter((p) => p.type === "reasoning");
    const joined = rParts.map((p) => (p as { text: string }).text).join("");
    expect(joined).toContain("def");
  });

  it("does not leak turn N reasoning into turn N+1 parts when a turn-end event was missed", () => {
    const { transport, emit } = createFakeTransport();
    const a = createPartAssembler(transport, params);
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "long turn-one reasoning text" } },
    });
    emit({
      type: "inference.tool_call.start",
      data: { callId: "c1", name: "exa" },
    });
    // turn.committed lost (reconnect gap); new turn starts with fresh cumulative blob
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "t2" } },
    });
    const rParts = a.parts.filter((p) => p.type === "reasoning");
    const texts = rParts.map((p) => (p as { text: string }).text);
    expect(texts.some((t) => t.includes("t2"))).toBe(true);
  });
});
